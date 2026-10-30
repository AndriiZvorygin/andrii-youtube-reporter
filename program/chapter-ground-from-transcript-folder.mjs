#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { formatChapterTimestamp } from "./chapter-timestamps.mjs";

function usage() {
  process.stdout.write("Usage: node program/chapter-ground-from-transcript-folder.mjs <transcript_dir> [prefix]\n");
}

function pyaEsc(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function parseGrossRows(pyaText) {
  const rows = [];
  const lines = String(pyaText || "").split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^su name chapter gross chunk\s+([^\s]+)\s+since num\s+([0-9.]+)\s+until num\s+([0-9.]+)\s+ob text\s+"([\s\S]+)"\s+ya$/u);
    if (!m) continue;
    let payload = {};
    try {
      payload = JSON.parse(JSON.parse(`"${m[4]}"`));
    } catch {
      payload = {};
    }
    rows.push({
      chunkId: String(payload["chunk id"] || m[1] || "").trim(),
      chapterTitle: String(payload["chapter title"] || "").trim(),
      chunkSummary: String(payload["chunk summary"] || "").trim(),
      rowStart: Number(payload["row start"]),
      rowEnd: Number(payload["row end"]),
      since: Number(payload.since ?? m[2]),
      until: Number(payload.until ?? m[3]),
      durationSeconds: Number(payload["duration seconds"]),
      sourceRows: Number(payload["source rows"]),
      sourceExcerpt: String(payload["source excerpt"] || "").trim(),
    });
  }
  return rows.filter((r) => Number.isFinite(r.since) && Number.isFinite(r.until) && r.until >= r.since);
}

function cleanTitle(text) {
  return String(text || "")
    .replace(/^[-*\d.\s]+/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
}

function ensureDistinctTitles(units) {
  const seen = new Set();
  for (const u of units) {
    let base = cleanTitle(u.chapterTitle) || "Stream Discussion";
    let title = base;
    let n = 2;
    while (seen.has(title.toLowerCase())) {
      title = `${base} ${n}`;
      n += 1;
    }
    seen.add(title.toLowerCase());
    u.chapterTitle = title;
  }
}

function validateGrounding(units) {
  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    if (!Number.isFinite(u.since) || !Number.isFinite(u.until) || u.until < u.since) {
      throw new Error(`invalid chapter timing at index=${i}`);
    }
    if (i > 0) {
      const prev = units[i - 1];
      if (u.since + 0.001 < prev.since) throw new Error(`non-monotonic since at index=${i}`);
      if (u.since + 0.001 < prev.until) throw new Error(`overlap at index=${i}`);
    }
  }
}

function main() {
  const transcriptDirArg = process.argv[2];
  const prefix = process.argv[3] || "meeting-qwen-auto-normalized";
  if (!transcriptDirArg) {
    usage();
    process.exit(2);
  }

  const transcriptDir = path.resolve(process.cwd(), transcriptDirArg);
  const grossPath = path.join(transcriptDir, `${prefix}.chapter.gross-chunks.pya`);
  const outPath = path.join(transcriptDir, `${prefix}.chapter.grounding.pya`);
  const wisePath = path.join(transcriptDir, `${prefix}.chapter-wise.series.pya`);
  const chaptersTxtPath = path.join(transcriptDir, `${prefix}.chapters.txt`);

  if (!fs.existsSync(grossPath)) throw new Error(`gross chunks missing: ${grossPath}`);
  const grossRows = parseGrossRows(fs.readFileSync(grossPath, "utf8"));
  if (!grossRows.length) throw new Error(`no gross rows parsed from ${grossPath}`);

  const units = grossRows
    .map((g, idx) => ({
      chapterId: `chapter_${String(idx + 1).padStart(3, "0")}`,
      chapterTitle: cleanTitle(g.chapterTitle) || `Segment ${idx + 1}`,
      chapterText: String(g.chunkSummary || "").trim(),
      rowStart: Number.isFinite(g.rowStart) ? g.rowStart : idx,
      rowEnd: Number.isFinite(g.rowEnd) ? g.rowEnd : idx,
      since: g.since,
      until: g.until,
      durationSeconds: Math.max(0, g.until - g.since),
      sourceRows: Number.isFinite(g.sourceRows) ? g.sourceRows : Math.max(1, (Number(g.rowEnd) - Number(g.rowStart) + 1)),
      parentChunkId: g.chunkId,
      sourceExcerpt: String(g.sourceExcerpt || "").trim(),
    }))
    .sort((a, b) => a.since - b.since);

  // YouTube requires the first chapter marker to begin with exactly 00:00. The
  // first transcript cue can begin a second or two later because of silence
  // trimming, but that offset must not make the published chapter list
  // invalid. Preserve the real end boundary while extending the first
  // chapter back to the start of the video.
  if (units.length) {
    units[0].since = 0;
    units[0].durationSeconds = Math.max(0, units[0].until - units[0].since);
  }

  ensureDistinctTitles(units);
  validateGrounding(units);

  const groundingLines = ["su name chapter grounding artifact be series def"];
  const wiseLines = ["su name chapter wise series artifact be series def"];
  const chapterLines = [];

  for (let index = 0; index < units.length; index += 1) {
    const u = units[index];
    const payload = {
      "chapter id": u.chapterId,
      "chapter title": u.chapterTitle,
      "chapter text": u.chapterText,
      "row start": u.rowStart,
      "row end": u.rowEnd,
      since: u.since,
      until: u.until,
      "duration seconds": u.durationSeconds,
      "source rows": u.sourceRows,
      "parent chunk id": u.parentChunkId,
      "source excerpt": u.sourceExcerpt,
    };
    groundingLines.push(`su name chapter grounding unit ${u.chapterId} since num ${Number(u.since).toFixed(3)} until num ${Number(u.until).toFixed(3)} ob text "${pyaEsc(JSON.stringify(payload))}" ya`);
    wiseLines.push(`su name chapter wise chip ${u.chapterId} since num ${Number(u.since).toFixed(3)} until num ${Number(u.until).toFixed(3)} ob text "${pyaEsc(u.chapterTitle)}" ya`);
    // YouTube requires the first description marker to begin at exactly
    // 00:00. Use the compact form for that first marker and keep the
    // unambiguous HH:MM:SS form for later chapters.
    chapterLines.push(`${formatChapterTimestamp(u.since, { first: index === 0 })} ${u.chapterTitle}`);
  }
  groundingLines.push("prah");
  wiseLines.push("prah");

  fs.writeFileSync(outPath, `${groundingLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(wisePath, `${wiseLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(chaptersTxtPath, `${chapterLines.join("\n")}\n`, "utf8");

  process.stdout.write(`[chapter-ground] gross: ${grossPath}\n`);
  process.stdout.write(`[chapter-ground] chapters: ${units.length}\n`);
  process.stdout.write(`[chapter-ground] wrote: ${outPath}\n`);
  process.stdout.write(`[chapter-ground] wrote: ${wisePath}\n`);
  process.stdout.write(`[chapter-ground] wrote: ${chaptersTxtPath}\n`);
}

main();
