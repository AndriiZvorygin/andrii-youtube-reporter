#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { normalizeSummaryFocus } from "./defaults.mjs";
import { requestManagedOllamaChat } from "../../../../program/runtime/gpu/managed-ollama.mjs";

function usage() {
  process.stdout.write("Usage: node program/summarize-whole-video-from-chapter-summary.mjs <transcript_dir> [prefix] [focus]\n");
}

function pyaEsc(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function parseChapterSummary(pyaText) {
  const out = [];
  const lines = String(pyaText || "").split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^su name chapter summary unit\s+([^\s]+)\s+since num\s+([0-9.]+)\s+until num\s+([0-9.]+)\s+ob text\s+"([\s\S]+)"\s+ya$/u);
    if (!m) continue;
    let payload = {};
    try { payload = JSON.parse(JSON.parse(`"${m[4]}"`)); } catch { payload = {}; }
    out.push({
      chapterId: String(payload["chapter id"] || m[1]).trim(),
      chapterTitle: String(payload["chapter title"] || "").trim(),
      summary: String(payload.summary || "").trim(),
      since: Number(payload.since ?? m[2]),
      until: Number(payload.until ?? m[3]),
      durationSeconds: Number(payload["duration seconds"]),
    });
  }
  return out.filter((r) => Number.isFinite(r.since) && Number.isFinite(r.until) && r.until >= r.since);
}

function groupSections(sections, targetBytes = 12000, maxBytes = 16000) {
  const out = [];
  let cursor = 0;
  while (cursor < sections.length) {
    const start = cursor;
    let end = start;
    let text = `${sections[start].chapterTitle}\n${sections[start].summary}`;
    while (end + 1 < sections.length) {
      const nextText = `${text}\n\n${sections[end + 1].chapterTitle}\n${sections[end + 1].summary}`;
      const bytes = Buffer.byteLength(nextText, "utf8");
      if (bytes > maxBytes) break;
      text = nextText;
      end += 1;
      if (bytes >= targetBytes) break;
    }
    out.push({
      start,
      end,
      sourceText: text,
      sourceBytes: Buffer.byteLength(text, "utf8"),
    });
    cursor = end + 1;
  }
  return out;
}

async function askOllama({ prompt, maxTokens = 260 }) {
  const host = String(process.env.OLLAMA_HOST || "http://mriczo:11434").replace(/\/+$/u, "");
  const json = await requestManagedOllamaChat({
    ollamaUrl: host,
    managerUrl: process.env.PYA_GPU_HOUSEKEEPER_URL || "",
    keepAlive: 180,
    think: false,
    options: { num_predict: maxTokens, temperature: 0.2 },
    messages: [
      { role: "system", content: "You summarize long-form transcript content accurately." },
      { role: "user", content: prompt },
    ],
    timeoutMs: Number(process.env.ANDRII_OLLAMA_TIMEOUT_MS || 300000),
  });
  return String(json?.message?.content || json?.response || "").trim();
}

function hasWeakMetaFraming(text = "") {
  const s = String(text || "").toLowerCase();
  return [
    "the transcript",
    "the narrative",
    "the provided chapters",
    "the text",
    "the transcript argues",
    "is portrayed as",
    "is critiqued for",
    "from a distributist perspective",
    "elite-driven",
    "ultimately,",
    "strategic maneuver by elites",
    "cohesive critique",
    "modern economic system",
    "this analysis highlights",
    "ultimately, the text argues",
  ].some((needle) => s.includes(needle));
}

function canonicalSpeakerRoster() {
  const raw = String(process.env.PYA_SPEAKER_NAME_ROSTER || "").trim();
  const titleCase = (value) => String(value || "").split(/\s+/u).map((token) => token
    ? `${token.slice(0, 1).toLocaleUpperCase()}${token.slice(1).toLocaleLowerCase()}` : token).join(" ");
  const names = raw.split(/[;\n|]+/u).map((item) => String(item || "").trim()).filter(Boolean).map((item) => {
    const comma = item.match(/^([^,]+),\s*(.+)$/u);
    return titleCase(comma ? `${comma[2]} ${comma[1]}` : item);
  }).filter(Boolean);
  const moderator = titleCase(process.env.PYA_SPEAKER_MODERATOR_NAME || "");
  if (moderator && !names.some((name) => name.toLocaleLowerCase() === moderator.toLocaleLowerCase())) names.push(moderator);
  return names.join("; ");
}



function factualLeadLooksWeak(text = "") {
  const first = String(text || "").split(/\n+/u).map((x) => x.trim()).find(Boolean) || "";
  if (!first) return true;
  const lower = first.toLowerCase();
  if (hasWeakMetaFraming(first)) return true;
  if (lower.startsWith("the transcript")) return true;
  return false;
}

async function main() {
  const transcriptDirArg = process.argv[2];
  const prefix = process.argv[3] || "meeting-qwen-auto-normalized";
  const focus = normalizeSummaryFocus(process.argv[4]);
  if (!transcriptDirArg) {
    usage();
    process.exit(2);
  }

  const transcriptDir = path.resolve(process.cwd(), transcriptDirArg);
  const chapterSummaryPath = path.join(transcriptDir, `${prefix}.chapter-summary.pya`);
  const chunksPath = path.join(transcriptDir, `${prefix}.meeting-summary.chunks.pya`);
  const meetingSummaryPyaPath = path.join(transcriptDir, `${prefix}.meeting-summary.pya`);
  const meetingSummaryMdPath = path.join(transcriptDir, `${prefix}.meeting-summary.md`);

  if (!fs.existsSync(chapterSummaryPath)) throw new Error(`chapter summary missing: ${chapterSummaryPath}`);
  const sections = parseChapterSummary(fs.readFileSync(chapterSummaryPath, "utf8"));
  if (!sections.length) throw new Error(`no chapter summaries parsed from ${chapterSummaryPath}`);
  const speakerRoster = canonicalSpeakerRoster();

  // Keep synthesis windows bounded by source size while retaining multiple
  // chronological bands. A single oversized window lets the final model
  // over-weight the opening chapters and discard the tail of long streams.
  const groups = groupSections(sections, 5000, 7000);
  // Match output density to the amount of source material. Requiring six
  // bullets and an eight-to-ten-sentence paragraph for a 30-second interview
  // forces the model to repeat itself or invent filler. Longer recordings
  // retain the fuller six-item format.
  const targetSentenceMin = groups.length >= 3 ? 8 : (groups.length === 2 ? 5 : 4);
  const targetSentenceMax = Math.min(10, targetSentenceMin + 2);
  const targetBulletCount = groups.length >= 3 ? 6 : (groups.length === 2 ? 4 : 3);
  const chunkRows = [];
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    let chunkSummary = "";
    try {
      chunkSummary = (await askOllama({
        maxTokens: 240,
        prompt: [
          "Summarize these chapter summaries in one detailed paragraph (3-5 sentences).",
          `Focus: ${focus}`,
          "Keep the summary neutral and source-faithful. Attribute personal opinions to the speaker and omit insults, speculation, and claims about motives or outcomes.",
          "Preserve proposals as proposals (suggests, discusses, considers); do not turn them into completed actions.",
          speakerRoster ? `Operator-confirmed speaker roster (use these exact spellings whenever the summary names one of these people): ${speakerRoster}` : "",
          g.sourceText,
        ].join("\n\n"),
      })).replace(/\s+/gu, " ").trim() || chunkSummary;
    } catch (error) {
      throw new Error(`chunk ${i + 1} summary failed: ${String(error?.message || error)}`);
    }
    if (!chunkSummary) throw new Error(`chunk ${i + 1} summary returned empty output`);
    chunkRows.push({
      chunkId: `meeting_chunk_${String(i + 1).padStart(3, "0")}`,
      chapterStart: g.start,
      chapterEnd: g.end,
      sourceCount: g.end - g.start + 1,
      sourceBytes: g.sourceBytes,
      chapterTitles: sections.slice(g.start, g.end + 1).map((section) => section.chapterTitle),
      chunkSummary,
    });
  }

  const chunkLines = ["su name meeting summary chunks artifact be series def"];
  for (const c of chunkRows) {
    const payload = {
      "chunk id": c.chunkId,
      "chapter start index": c.chapterStart,
      "chapter end index": c.chapterEnd,
      "source section count": c.sourceCount,
      "source byte count": c.sourceBytes,
      "chapter titles": c.chapterTitles,
      "chunk summary text": c.chunkSummary,
    };
    chunkLines.push(`su name meeting summary chunk ${c.chunkId} since num ${Number(c.chapterStart).toFixed(3)} until num ${Number(c.chapterEnd).toFixed(3)} ob text "${pyaEsc(JSON.stringify(payload))}" ya`);
  }
  chunkLines.push("prah");
  fs.writeFileSync(chunksPath, `${chunkLines.join("\n")}\n`, "utf8");

  const chunkText = chunkRows.map((c) => [
    `- ${c.chunkId}`,
    `Chronological topics: ${c.chapterTitles.join(" | ")}`,
    `Source-grounded band summary: ${c.chunkSummary}`,
  ].join("\n")).join("\n\n");
  let finalMd = "";
  try {
    finalMd = await askOllama({
      maxTokens: 1000,
      prompt: [
        "Write markdown with exact sections:",
        "## Whole Stream Summary",
        `Exactly one paragraph (${targetSentenceMin}-${targetSentenceMax} sentences) so the summary represents the full recording, including later chapters.`,
        groups.length >= 3
          ? "Write the sentences in chronological order: sentences 1-3 draw from the first coverage band, sentences 4-6 from the middle band, and the remaining sentences from the final band."
          : "Write the sentences in chronological order and cover each available coverage band without repeating a point.",
        "Write in educational episode voice for general audience.",
        "Do not use third-person meta framing (the transcript/the text/the chapters), or phrases such as 'interspersed with these discussions' and 'the summaries emphasize'. State the concrete topic directly.",
        "Use plain direct factual phrasing, no rhetorical filler.",
        "Do not assign ideological, economic, religious, or political labels unless that exact term appears in the source chapter text. Describe what speakers discuss and propose; do not infer a worldview, motive, endorsement, or outcome.",
        "Preserve uncertainty and qualifications from the chapter text, including any statement that a speaker cannot promise a price or outcome.",
        "Do not turn stalled or not-proceeding developments into rejected developments, and do not present a discussion point as a confirmed result.",
        "Coverage rule: include at least one distinct concrete topic from every chronological band in the whole-stream paragraph, and name the specific late-band topics when they are substantive (for example a named person, a technical process, or a practical activity). Distribute the bullet points across those bands.",
        "Avoid duplication: each sentence and bullet should add a different topic; do not repeat the same housing, campaign, or technology point in multiple places.",
        speakerRoster ? `Operator-confirmed speaker roster (use these exact spellings whenever the summary names one of these people): ${speakerRoster}` : "",
        "## Most Newsworthy Items",
        `Exactly ${targetBulletCount} bullet points, distributed across the available chronological coverage bands.`,
        "Each bullet must begin with a concrete topic and factual claim.",
        "No sensational words (collapse, catastrophic, doomed) unless directly quoted and attributed.",
        "Stay source-faithful. Do not call the speaker's material distributist, ideological, or political unless that exact word appears in the source material.",
        `Focus: ${focus}`,
        "",
        "Chunk summaries:",
        chunkText,
      ].join("\n"),
    });
    if (factualLeadLooksWeak(finalMd)) {
      finalMd = await askOllama({
        maxTokens: 1000,
        prompt: [
          "Rewrite this markdown in plain educational episode style.",
          "Keep exact headings:",
          "## Whole Stream Summary",
          "## Most Newsworthy Items",
          "Rules:",
          "- Lead with concrete facts discussed in the stream.",
          "- No phrases like 'the transcript', 'the narrative', or ideological framing.",
          "- Do not add ideological labels that do not appear in the source chapter text.",
          "- Preserve explicit uncertainty such as cannot promise, may, might, or could.",
          `- Whole Stream Summary must be exactly one paragraph (no blank lines).\n- Begin with: In this episode, you will learn ...\n- No duplicated opener phrases.\n- No phrases: the transcript, the text, the chapters, is portrayed as, is critiqued for.\n- Avoid rhetorical words: inevitable, collapse, reckoning, dogma.\n- Keep exactly ${targetBulletCount} distinct factual bullet points, distributed across the available chronological coverage bands.\n- Write the whole-stream sentences in chronological order and cover the final available band explicitly.`,
          speakerRoster ? `- Use these exact speaker spellings whenever names appear: ${speakerRoster}` : "",
          "",
          finalMd,
        ].join("\n"),
      }) || finalMd;
    }
  } catch (error) {
    throw new Error(`whole-stream summary failed: ${String(error?.message || error)}`);
  }

  const meetingPayload = {
    "chunk count": chunkRows.length,
    "chapter count": sections.length,
    "summary markdown": finalMd,
  };
  const pyaLines = [
    "su name meeting summary artifact be map def",
    `su name chunk count be num ${chunkRows.length} ya`,
    `su name chapter count be num ${sections.length} ya`,
    `su name summary markdown be text "${pyaEsc(finalMd)}" ya`,
    "prah",
  ];

  fs.writeFileSync(meetingSummaryPyaPath, `${pyaLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(meetingSummaryMdPath, `${finalMd.trim()}\n`, "utf8");

  process.stdout.write(`[meeting-summary] chapter summary: ${chapterSummaryPath}\n`);
  process.stdout.write(`[meeting-summary] chunks: ${chunkRows.length}\n`);
  process.stdout.write(`[meeting-summary] wrote: ${chunksPath}\n`);
  process.stdout.write(`[meeting-summary] wrote: ${meetingSummaryPyaPath}\n`);
  process.stdout.write(`[meeting-summary] wrote: ${meetingSummaryMdPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
