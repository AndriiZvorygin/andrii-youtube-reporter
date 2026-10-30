#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { requestManagedOllamaChat } from "../../../../program/runtime/gpu/managed-ollama.mjs";
import {
  findAuthoritativeChapterFile,
  parseAuthoritativeChapterText,
} from "./chapter-timestamps.mjs";

function usage() {
  process.stdout.write("Usage: node program/chapter-gross-from-transcript-folder.mjs <transcript_dir> [prefix]\n");
}

function existsFile(p) {
  try { return fs.existsSync(p) && fs.statSync(p).isFile(); } catch { return false; }
}

function pyaEsc(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function parseSrt(text) {
  const blocks = String(text || "").split(/\r?\n\r?\n+/u);
  const rows = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const tm = lines[1].match(/^(\d\d):(\d\d):(\d\d),(\d\d\d)\s+-->\s+(\d\d):(\d\d):(\d\d),(\d\d\d)$/u);
    if (!tm) continue;
    const since = Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]) + Number(tm[4]) / 1000;
    const until = Number(tm[5]) * 3600 + Number(tm[6]) * 60 + Number(tm[7]) + Number(tm[8]) / 1000;
    const lineText = lines.slice(2).join(" ").replace(/\s+/gu, " ").trim();
    if (!lineText) continue;
    const speaker = lineText.match(/^([^:]{1,80}):\s+/u);
    rows.push({
      since,
      until,
      speaker_key: speaker ? speaker[1].trim().toLocaleLowerCase() : "",
      text: lineText,
    });
  }
  return rows;
}

function secondsToHms(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

async function askOllama({ prompt, system, maxTokens = 120 }) {
  const host = String(process.env.OLLAMA_HOST || "http://mriczo:11434").replace(/\/+$/u, "");
  const attempts = Math.max(1, Number(process.env.ANDRII_OLLAMA_RETRY_ATTEMPTS || 6));
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const json = await requestManagedOllamaChat({
        ollamaUrl: host,
        managerUrl: process.env.PYA_GPU_HOUSEKEEPER_URL || "",
        keepAlive: 180,
        think: false,
        options: { num_predict: maxTokens, temperature: 0.2 },
        messages: [
          { role: "system", content: system || "You write concise transcript labels." },
          { role: "user", content: prompt },
        ],
        timeoutMs: Number(process.env.ANDRII_OLLAMA_TIMEOUT_MS || 300000),
      });
      return String(json?.message?.content || json?.response || "").trim();
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      const capacityOnly = /GPU capacity|capacity remains insufficient|local execution slot occupied|timed out waiting for remote job/iu.test(message);
      if (!capacityOnly || attempt >= attempts) throw error;
      const delayMs = Math.min(120000, 5000 * attempt);
      process.stderr.write(`[chapter-gross] managed GPU busy; retry ${attempt + 1}/${attempts} after ${delayMs}ms\n`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("managed Ollama request failed");
}

function chooseMergedSrt(transcriptDir, prefix) {
  // Keep diarization labels in the grounded source whenever available. They
  // let the chapter summarizer distinguish the guest from the interviewer
  // instead of attributing every statement in a conversational window to one
  // person. The cue timings are the same canonical sentence timings.
  const speakerPreferred = path.join(transcriptDir, `${prefix}.sentences.speaker.sentence.srt`);
  if (existsFile(speakerPreferred)) return speakerPreferred;
  const preferred = path.join(transcriptDir, `${prefix}.sentences.merged.srt`);
  if (existsFile(preferred)) return preferred;
  const candidates = fs.readdirSync(transcriptDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => d.name)
    .filter((n) => n.endsWith(".sentences.merged.srt"))
    .sort();
  if (!candidates.length) throw new Error(`no *.sentences.merged.srt found in ${transcriptDir}`);
  return path.join(transcriptDir, candidates[candidates.length - 1]);
}

function nearestRowIndex(rows, targetSeconds, minimumIndex = 0) {
  const start = Math.max(0, Math.min(rows.length - 1, Number(minimumIndex) || 0));
  let best = start;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = start; index < rows.length; index += 1) {
    const distance = Math.abs(Number(rows[index].since || 0) - Number(targetSeconds || 0));
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
    // Once the source timeline has passed the target, later rows cannot be
    // closer. Keeping this monotonic makes the mapping stable even when the
    // official and downloaded recordings have small timing drift.
    if (Number(rows[index].since || 0) > Number(targetSeconds || 0) && distance > bestDistance) break;
  }
  return { index: best, distance: bestDistance };
}

function authoritativeIdentityTitle(title) {
  return /^(?:opening|closing):\s*\S/iu.test(String(title || "").trim());
}

function refineAuthoritativeStarts(rows, chapters, starts) {
  const refined = [...starts];
  const isControl = (text) => {
    const value = String(text || "").replace(/^[^:]{1,80}:\s*/u, "").replace(/\s+/gu, " ").trim();
    return /^(?:next up|and\s+next|opening statement|the question|question(?: is|:)|first up|second will|third will|fourth will|fifth will|sixth will|our next|we(?:'re| are) going|please|let(?:'s| us)|time-wise|before i|each candidate|we have|thank you(?:[,.]|$)|is\s+[^.?!]{1,50}\?)/iu.test(value)
      || /\b(?:the question is|for this next question|we(?:'re| are) going to start|when we do closing remarks|will be from)\b/iu.test(value);
  };
  for (let i = 0; i < chapters.length; i += 1) {
    if (!authoritativeIdentityTitle(chapters[i].title)) continue;
    let index = refined[i];
    const original = rows[index];
    if (!original) continue;
    const closing = /^closing:/iu.test(chapters[i].title);
    const priorKey = rows[Math.max(0, index - 1)]?.speaker_key;
    if (isControl(original.text)) {
      let cursor = index;
      while (cursor < rows.length && isControl(rows[cursor]?.text)) cursor += 1;
      // Closing markers often land on a final thanks/handoff from the prior
      // candidate. Follow the diarization handoff after the control cue.
      if (closing && priorKey && rows[cursor]?.speaker_key === priorKey
        && String(rows[cursor]?.text || "").replace(/^[^:]{1,80}:\s*/u, "").trim().length < 80) {
        while (cursor < rows.length && rows[cursor]?.speaker_key === priorKey) cursor += 1;
      }
      if (cursor < rows.length) index = cursor;
    } else if (closing && priorKey && original.speaker_key === priorKey) {
      let cursor = index;
      while (cursor < rows.length && rows[cursor]?.speaker_key === priorKey) cursor += 1;
      if (cursor < rows.length) index = cursor;
    }
    const previous = i > 0 ? refined[i - 1] + 1 : 0;
    refined[i] = Math.max(previous, Math.min(rows.length - 1, index));
  }
  return refined;
}

function windowsFromAuthoritativeChapters(rows, chapters) {
  if (!Array.isArray(chapters) || chapters.length < 2) return { windows: [], alignment: [] };
  const starts = [];
  let minimumIndex = 0;
  for (const chapter of chapters) {
    const match = nearestRowIndex(rows, chapter.since, minimumIndex);
    const index = starts.length && match.index <= starts[starts.length - 1]
      ? Math.min(rows.length - 1, starts[starts.length - 1] + 1)
      : match.index;
    starts.push(index);
    minimumIndex = index;
  }
  const refinedStarts = refineAuthoritativeStarts(rows, chapters, starts);
  const windows = chapters.map((chapter, index) => {
    const rowStart = refinedStarts[index];
    const rowEnd = index + 1 < refinedStarts.length ? Math.max(rowStart, refinedStarts[index + 1] - 1) : rows.length - 1;
    const sourceRows = rows.slice(rowStart, rowEnd + 1);
    const sourceText = sourceRows.map((row) => row.text).join(" ").replace(/\s+/gu, " ").trim();
    const nextOfficial = chapters[index + 1]?.since;
    // The authoritative timestamps are the source of truth for published
    // chapters. Source-row timings are retained only for grounding the
    // summaries to transcript text.
    const until = Number.isFinite(nextOfficial)
      ? nextOfficial
      : Math.max(chapter.since + 1, chapter.since + Math.min(600, Number(sourceRows.at(-1)?.until || chapter.since) - Number(sourceRows[0]?.since || chapter.since)));
    return {
      rowStart,
      rowEnd,
      since: chapter.since,
      until,
      durationSeconds: Math.max(0, until - chapter.since),
      sourceRows: sourceRows.length,
      sourceBytes: Buffer.byteLength(sourceText, "utf8"),
      sourceText,
      chapterTitle: chapter.title,
    };
  });
  const alignment = chapters.map((chapter, index) => ({
    index: index + 1,
    title: chapter.title,
    authoritative_since: chapter.since,
    transcript_since: Number(rows[refinedStarts[index]]?.since || 0),
    transcript_row: refinedStarts[index] + 1,
    offset_seconds: Number((Number(rows[refinedStarts[index]]?.since || 0) - chapter.since).toFixed(3)),
  }));
  return { windows, alignment };
}

function isTopicShiftCue(text) {
  const t = String(text || "").toLowerCase().replace(/\s+/gu, " ").trim();
  if (!t) return false;
  return [
    /^another topic\b/u,
    /^(?:okay[,.]?\s+)?(?:another|other)\s+(?:thing|main thing|topic|aspect|issue)\b/u,
    /\bthe thing about\b/u,
    /\bwhat about\b/u,
    /\bturning to\b/u,
    /\bon another issue\b/u,
    /\banything else more to add\b/u,
    /\bcompassion element\b/u,
    /\bto that end, as mayor\b/u,
    /\bfor example, when i first started attending\b/u,
    /\bthat's just one example\b/u,
    /\bi have also explored\b.*\bhousing\b/u,
    /\bhousing plan\b/u,
    /\bcommunity land trusts?\b/u,
    /\banother aspect of this\b/u,
    /\bhormuz crisis\b/u,
    /\bfood systems?\b/u,
    /\bfood prices\b/u,
    /\blocal food processing\b/u,
    /\btransparency initiative\b/u,
    /\bi also have a website\b/u,
  ].some((re) => re.test(t));
}

function chapterWindowDefaults({ meetingContext, durationSeconds }) {
  const context = String(meetingContext || "");
  const isInterview = /\binterviews?\b|\bq(?:uestion|&)\s*a\b|\bcandidate\b/iu.test(context);
  const duration = Number(durationSeconds) || 0;

  // Interviews are conversational and usually move through several discrete
  // questions or policy areas.  Use finer defaults for short interviews so a
  // brief video does not collapse into two broad chapters.  These are only
  // defaults: callers can still tune every boundary with the existing
  // ANDRII_CHAPTER_* environment variables.
  if (isInterview && duration > 0 && duration <= 20 * 60) {
    return {
      minSeconds: 60,
      maxSeconds: 150,
      pauseSeconds: 4,
      topicShiftMinSeconds: 35,
      interview: true,
    };
  }
  if (isInterview) {
    return {
      minSeconds: 120,
      maxSeconds: 240,
      pauseSeconds: 6,
      topicShiftMinSeconds: 70,
      interview: true,
    };
  }
  return {
    minSeconds: 180,
    maxSeconds: 360,
    pauseSeconds: 8,
    topicShiftMinSeconds: 90,
    interview: false,
  };
}

function splitIntoWindows(rows, {
  minSeconds = 180,
  maxSeconds = 360,
  pauseSeconds = 8,
  topicShiftMinSeconds = 90,
  maxSourceChars = 12000,
} = {}) {
  const out = [];
  let cursor = 0;
  while (cursor < rows.length) {
    const start = cursor;
    let end = start;
    const since = rows[start].since;
    let until = rows[start].until;
    let sourceChars = String(rows[start].text || "").length;
    while (end + 1 < rows.length) {
      const next = rows[end + 1];
      const dur = next.until - since;
      const pause = Math.max(0, Number(next.since || 0) - Number(rows[end].until || 0));
      const curDur = until - since;
      if (curDur >= topicShiftMinSeconds && isTopicShiftCue(next.text)) break;
      if (dur >= maxSeconds) break;
      const nextChars = String(next.text || "").length + 1;
      if (sourceChars + nextChars > maxSourceChars) break;
      end += 1;
      until = rows[end].until;
      sourceChars += nextChars;
      const updatedDur = until - since;
      if (updatedDur >= minSeconds && pause >= pauseSeconds) break;
    }
    if (end < start) end = start;
    const chunkRows = rows.slice(start, end + 1);
    const text = chunkRows.map((r) => r.text).join(" ").replace(/\s+/gu, " ").trim();
    out.push({
      rowStart: start,
      rowEnd: end,
      since,
      until: rows[end].until,
      durationSeconds: Math.max(0, rows[end].until - since),
      sourceRows: chunkRows.length,
      sourceBytes: Buffer.byteLength(text, "utf8"),
      sourceText: text,
    });
    cursor = end + 1;
  }
  return out;
}

function cleanTitle(text) {
  return String(text || "")
    .replace(/^[-*\d.\s]+/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
}

function parseJsonObjectFromModel(text) {
  const raw = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .trim();
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(raw.slice(start, end + 1));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

async function adjudicateTopicTitle({ draft, titleSource, meetingContext }) {
  let current = cleanTitle(draft) || "Stream Segment";
  let issue = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await askOllama({
      // Qwen may explain why a draft is not topic-only before returning its
      // rewrite.  Keep enough output budget for a complete JSON object; a
      // truncated `issues` array otherwise makes an otherwise valid title
      // look unparsable and needlessly aborts the whole chapter stage.
      maxTokens: 192,
      system: "You adjudicate topic-only YouTube chapter titles. Return JSON only.",
      prompt: [
        "Return exactly JSON with keys pass (boolean), title (string), and issues (array of strings). Keep each issue short and include at most 2 issues.",
        "The title must be a neutral, specific 3-8 word label for the shared topic or policy discussed in the excerpt.",
        "Hard rule: never include a candidate's, moderator's, host's, guest's, staff member's, or any other person's name, and never include a SPEAKER label. This rule applies even when one person speaks for most of the excerpt.",
        "Do not turn a person's biography, criticism, prediction, or characterization of another person into the title. Replace it with the underlying policy, service, proposal, or event.",
        "A broad but concrete topic label is valid even when the excerpt is not proposing a policy: energy limits, municipal planning, AI infrastructure, civilizational risk, and housing affordability are acceptable topic labels when grounded in the excerpt. Do not reject a title merely because it lacks a named policy proposal.",
        "If the draft is grounded and contains no person's name, set pass true. If it needs revision, rewrite it to a grounded topic-only label and set pass true in the same response; do not leave pass false after supplying a rewrite.",
        "Set pass true only when TITLE is topic-only and source-grounded. If it is not, rewrite it and set pass true when the rewrite is clean.",
        `DRAFT TITLE: ${current}`,
        issue ? `PREVIOUS ISSUE: ${issue}` : "",
        `KNOWN_CONTEXT: ${meetingContext || "Unknown"}`,
        titleSource,
      ].filter(Boolean).join("\n\n"),
    });
    const parsed = parseJsonObjectFromModel(response);
    const next = cleanTitle(normalizeKnownLocationErrors(parsed?.title, knownLocationFromContext(meetingContext)));
    const issues = Array.isArray(parsed?.issues)
      ? parsed.issues.map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    if (next) current = next;
    if (parsed?.pass === true && current) return current;
    issue = issues.join("; ") || "title was not adjudicated as topic-only";
  }
  throw new Error(`topic-only chapter title adjudication failed: ${issue}`);
}

function readMeetingContext(transcriptDir) {
  const meetingPath = path.join(path.dirname(transcriptDir), "meeting.json");
  try {
    const payload = JSON.parse(fs.readFileSync(meetingPath, "utf8"))?.payload || {};
    return [
      String(payload?.meeting_name || "").trim(),
      String(payload?.uploader || "").trim(),
    ].filter(Boolean).join(" | ");
  } catch {
    return "";
  }
}

function knownLocationFromContext(context) {
  const text = String(context || "");
  if (/\bowen sound\b/iu.test(text)) return "Owen Sound";
  return "";
}

function normalizeKnownLocationErrors(text, knownLocation) {
  let out = String(text || "");
  if (knownLocation === "Owen Sound") {
    out = out.replace(/\b(?:long sound|olmsted|onondaga|oceanside)\b/giu, "Owen Sound");
    out = out.replace(/\bOwen Sound\s*\(\s*Owen Sound\s*\)/giu, "Owen Sound");
  }
  return out.replace(/\s+/gu, " ").trim();
}

function readQuestionBoundaries(filePath, rows) {
  if (!filePath || !existsFile(filePath)) return [];
  let payload;
  try { payload = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return []; }
  const raw = Array.isArray(payload?.boundaries) ? payload.boundaries : [];
  return raw.map((item) => {
    const row = Number(item?.row);
    const sourceRow = Number.isInteger(row) ? rows[row - 1] : null;
    if (!sourceRow) return null;
    const title = cleanTitle(item?.title || "");
    if (!title) return null;
    return {
      row,
      since: sourceRow.since,
      until: sourceRow.until,
      chapterTitle: title,
      kind: String(item?.kind || "question").trim(),
    };
  }).filter(Boolean).sort((a, b) => a.row - b.row);
}

function windowsFromQuestionBoundaries(rows, boundaries) {
  if (!boundaries.length) return [];
  const out = [];
  let cursor = 0;
  for (const boundary of boundaries) {
    const start = Math.max(0, boundary.row - 1);
    if (start < cursor) continue;
    if (start > cursor) {
      const openingRows = rows.slice(cursor, start);
      const openingText = openingRows.map((r) => r.text).join(" ").replace(/\s+/gu, " ").trim();
      if (openingText) {
        out.push({
          rowStart: cursor,
          rowEnd: start - 1,
          since: openingRows[0].since,
          until: openingRows[openingRows.length - 1].until,
          durationSeconds: Math.max(0, openingRows[openingRows.length - 1].until - openingRows[0].since),
          sourceRows: openingRows.length,
          sourceBytes: Buffer.byteLength(openingText, "utf8"),
          sourceText: openingText,
          chapterTitle: "",
        });
      }
    }
    cursor = start;
    const next = boundaries.find((candidate) => candidate.row > boundary.row);
    const end = next ? Math.max(start, next.row - 2) : rows.length - 1;
    const segmentRows = rows.slice(start, end + 1);
    const text = segmentRows.map((r) => r.text).join(" ").replace(/\s+/gu, " ").trim();
    if (!text) continue;
    out.push({
      rowStart: start,
      rowEnd: end,
      since: segmentRows[0].since,
      until: segmentRows[segmentRows.length - 1].until,
      durationSeconds: Math.max(0, segmentRows[segmentRows.length - 1].until - segmentRows[0].since),
      sourceRows: segmentRows.length,
      sourceBytes: Buffer.byteLength(text, "utf8"),
      sourceText: text,
      chapterTitle: boundary.chapterTitle,
    });
    cursor = end + 1;
    if (!next) break;
  }
  if (cursor < rows.length) {
    const tailRows = rows.slice(cursor);
    const text = tailRows.map((r) => r.text).join(" ").replace(/\s+/gu, " ").trim();
    if (text) out.push({
      rowStart: cursor,
      rowEnd: rows.length - 1,
      since: tailRows[0].since,
      until: tailRows[tailRows.length - 1].until,
      durationSeconds: Math.max(0, tailRows[tailRows.length - 1].until - tailRows[0].since),
      sourceRows: tailRows.length,
      sourceBytes: Buffer.byteLength(text, "utf8"),
      sourceText: text,
      chapterTitle: "",
    });
  }
  return out;
}

function ensureDistinctTitles(chunks) {
  const seen = new Set();
  for (const c of chunks) {
    let base = cleanTitle(c.chapterTitle) || "Stream Discussion";
    let title = base;
    let i = 2;
    while (seen.has(title.toLowerCase())) {
      title = `${base} ${i}`;
      i += 1;
    }
    seen.add(title.toLowerCase());
    c.chapterTitle = title;
  }
}

async function main() {
  const transcriptDirArg = process.argv[2];
  const prefix = process.argv[3] || "meeting-qwen-auto-normalized";
  if (!transcriptDirArg) {
    usage();
    process.exit(2);
  }

  const transcriptDir = path.resolve(process.cwd(), transcriptDirArg);
  if (!fs.existsSync(transcriptDir)) throw new Error(`transcript directory not found: ${transcriptDir}`);

  const srtPath = chooseMergedSrt(transcriptDir, prefix);
  const outPath = path.join(transcriptDir, `${prefix}.chapter.gross-chunks.pya`);
  const alignmentPath = path.join(transcriptDir, `${prefix}.official-chapters.alignment.pya`);
  const srtText = fs.readFileSync(srtPath, "utf8");
  const rows = parseSrt(srtText);
  if (!rows.length) throw new Error(`no transcript rows parsed from ${srtPath}`);
  const meetingContext = readMeetingContext(transcriptDir);
  const knownLocation = knownLocationFromContext(meetingContext);
  const videoDurationSeconds = Math.max(...rows.map((row) => Number(row.until) || 0));
  const defaults = chapterWindowDefaults({ meetingContext, durationSeconds: videoDurationSeconds });

  let windows = splitIntoWindows(rows, {
    minSeconds: Number(process.env.ANDRII_CHAPTER_MIN_SECONDS || defaults.minSeconds),
    maxSeconds: Number(process.env.ANDRII_CHAPTER_MAX_SECONDS || defaults.maxSeconds),
    pauseSeconds: Number(process.env.ANDRII_CHAPTER_PAUSE_SECONDS || defaults.pauseSeconds),
    topicShiftMinSeconds: Number(process.env.ANDRII_CHAPTER_TOPIC_SHIFT_MIN_SECONDS || defaults.topicShiftMinSeconds),
    maxSourceChars: Number(process.env.ANDRII_CHAPTER_MAX_SOURCE_CHARS || 12000),
  });
  const configuredBoundaryPath = String(process.env.ANDRII_CHAPTER_BOUNDARIES_PATH || "").trim();
  const questionMode = /^(1|true|yes|on)$/iu.test(String(process.env.PYA_CHAPTER_QUESTION_MODE || ""));
  const boundaryPath = configuredBoundaryPath || (questionMode
    ? path.join(transcriptDir, `${prefix}.question-boundaries.json`)
    : "");
  const questionBoundaries = readQuestionBoundaries(boundaryPath, rows);
  let authoritativeAlignment = [];
  const authoritativePath = findAuthoritativeChapterFile(transcriptDir, prefix);
  if (authoritativePath) {
    const authoritative = parseAuthoritativeChapterText(fs.readFileSync(authoritativePath, "utf8"));
    const mapped = windowsFromAuthoritativeChapters(rows, authoritative);
    if (mapped.windows.length < 2) {
      throw new Error(`authoritative chapter file has fewer than two usable chapters: ${authoritativePath}`);
    }
    windows = mapped.windows;
    authoritativeAlignment = mapped.alignment;
    process.stdout.write(`[chapter-gross] authoritative chapters: ${authoritative.length} from ${authoritativePath}\n`);
  } else if (questionBoundaries.length) {
    const questionWindows = windowsFromQuestionBoundaries(rows, questionBoundaries);
    if (questionWindows.length >= 2) {
      windows = questionWindows;
      process.stdout.write(`[chapter-gross] question mode: ${questionBoundaries.length} boundaries from ${boundaryPath}\n`);
    } else if (questionMode || configuredBoundaryPath) {
      throw new Error(`question chapter mode requested but boundaries produced only ${questionWindows.length} usable windows`);
    }
  } else if (questionMode || configuredBoundaryPath) {
    throw new Error(`question chapter mode requested but no usable boundaries found at ${boundaryPath}`);
  }

  const chunks = [];
  for (let i = 0; i < windows.length; i += 1) {
    const w = windows[i];
    const excerpt = String(w.sourceText || "").slice(0, Number(process.env.ANDRII_CHAPTER_MAX_SOURCE_CHARS || 12000));
    const titleSource = excerpt.length <= 6000
      ? excerpt
      : `${excerpt.slice(0, 3000)}\n\n[Later in this chapter]\n\n${excerpt.slice(-3000)}`;
    let chapterTitle = cleanTitle(w.chapterTitle) || "Stream Segment";
    let chunkSummary = "Transcript discussion and analysis.";
    if (!w.chapterTitle) {
      const titleOut = await askOllama({
        maxTokens: 32,
        system: "You write concise, source-faithful YouTube chapter titles. 3-8 words. No punctuation at end.",
        prompt: [
          "Write one concise, specific chapter title for this transcript excerpt.",
          "Avoid generic labels like discussion continues.",
          "Chapter titles are topic labels, not speaker labels: never include a candidate's, moderator's, host's, or any other person's name, even if that person speaks for most of the excerpt. When several people speak, use the shared topic or policy under discussion.",
          "Do not assign ideological, economic, religious, or political labels unless the speaker explicitly uses that exact term in the excerpt. Describe concrete topics instead of inferring a worldview or motive.",
          "For a conversational interview, do not turn one participant's criticism, insult, prediction, or characterization of another person into a factual title. Prefer a neutral topic title such as candidate comparison, housing discussion, or campaign planning, and omit personal names when they are not essential.",
          "Use KNOWN_CONTEXT to resolve obvious transcription errors in names and places.",
          ...(knownLocation ? [`The subject municipality is ${knownLocation}; do not introduce another municipality unless it is clearly and repeatedly named.`] : []),
          `KNOWN_CONTEXT: ${meetingContext || "Unknown"}`,
          titleSource,
        ].join("\n\n"),
      });
      chapterTitle = cleanTitle(normalizeKnownLocationErrors(titleOut, knownLocation)) || chapterTitle;

      // A chapter window commonly contains a moderator plus several
      // candidates. Run an explicit topic-only title adjudication after the
      // first draft so a dominant speaker's name cannot become the chapter
      // heading. A failed adjudication leaves the stage retryable instead of
      // silently publishing a speaker title.
      const structuralTitle = /^(?:candidate\s+)?(?:opening|closing)(?:\s+statements?)?$/iu.test(chapterTitle);
      if (!structuralTitle) {
        chapterTitle = await adjudicateTopicTitle({
          draft: chapterTitle,
          titleSource,
          meetingContext,
        });
      }
    }

    try {
      const sumOut = await askOllama({
        maxTokens: 100,
        system: "You summarize transcript excerpts with concrete details.",
        prompt: [
          "Summarize this segment in 1-2 sentences with concrete topics.",
          "Cover the full segment, including important points near the end.",
          "Stay strictly within the excerpt. Do not invent motives, ideologies, labels, outcomes, or policy positions that are not explicitly stated or directly paraphrased.",
          "Use KNOWN_CONTEXT to resolve obvious transcription errors in names and places.",
          ...(knownLocation ? [`The subject municipality is ${knownLocation}; do not introduce another municipality unless it is clearly and repeatedly named.`] : []),
          `KNOWN_CONTEXT: ${meetingContext || "Unknown"}`,
          excerpt,
        ].join("\n\n"),
      });
      chunkSummary = normalizeKnownLocationErrors(sumOut, knownLocation) || chunkSummary;
    } catch {
      // keep fallback
    }

    chunks.push({
      chunkId: `chunk_${String(i + 1).padStart(3, "0")}`,
      chapterTitle,
      chunkSummary,
      rowStart: w.rowStart,
      rowEnd: w.rowEnd,
      since: w.since,
      until: w.until,
      durationSeconds: w.durationSeconds,
      sourceRows: w.sourceRows,
      sourceBytes: w.sourceBytes,
      sourceExcerpt: excerpt,
    });
  }

  ensureDistinctTitles(chunks);

  const lines = ["su name chapter gross chunks artifact be series def"];
  for (const c of chunks) {
    const payload = {
      "chunk id": c.chunkId,
      "chapter title": c.chapterTitle,
      "chunk summary": c.chunkSummary,
      "row start": c.rowStart,
      "row end": c.rowEnd,
      since: c.since,
      until: c.until,
      "duration seconds": c.durationSeconds,
      "source rows": c.sourceRows,
      "source byte count": c.sourceBytes,
      "source excerpt": c.sourceExcerpt,
    };
    lines.push(`su name chapter gross chunk ${c.chunkId} since num ${Number(c.since).toFixed(3)} until num ${Number(c.until).toFixed(3)} ob text "${pyaEsc(JSON.stringify(payload))}" ya`);
  }
  lines.push("prah");
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");

  if (authoritativeAlignment.length) {
    const alignmentLines = ["su name official chapter alignment artifact be series def"];
    for (const entry of authoritativeAlignment) {
      alignmentLines.push(`su name official chapter alignment ${String(entry.index).padStart(3, "0")} ob text "${pyaEsc(JSON.stringify(entry))}" ya`);
    }
    alignmentLines.push("prah");
    fs.writeFileSync(alignmentPath, `${alignmentLines.join("\n")}\n`, "utf8");
    process.stdout.write(`[chapter-gross] wrote: ${alignmentPath}\n`);
  }

  process.stdout.write(`[chapter-gross] source srt: ${srtPath}\n`);
  process.stdout.write(`[chapter-gross] context: ${meetingContext || "Unknown"}\n`);
  process.stdout.write(`[chapter-gross] policy: ${defaults.interview ? "interview-aware" : "standard"} (${videoDurationSeconds.toFixed(1)}s)\n`);
  process.stdout.write(`[chapter-gross] chunks: ${chunks.length}\n`);
  process.stdout.write(`[chapter-gross] wrote: ${outPath}\n`);
  if (chunks.length) {
    process.stdout.write(`[chapter-gross] first: ${secondsToHms(chunks[0].since)} ${chunks[0].chapterTitle}\n`);
    process.stdout.write(`[chapter-gross] last: ${secondsToHms(chunks[chunks.length - 1].since)} ${chunks[chunks.length - 1].chapterTitle}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
