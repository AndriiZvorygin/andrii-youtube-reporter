#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { requestManagedOllamaChat } from "../../../../program/runtime/gpu/managed-ollama.mjs";

function usage() {
  process.stdout.write("Usage: node program/identify-question-boundaries-from-transcript-folder.mjs <transcript_dir> [prefix]\n");
}

function pyaEsc(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function parseJsonObjectFromModel(text) {
  const raw = String(text || "").trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/<think>[\s\S]*?<\/think>/giu, "")
    .trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function timestampToSeconds(value) {
  const m = String(value || "").match(/^(\d\d):(\d\d):(\d\d),(\d\d\d)$/u);
  if (!m) return Number.NaN;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

function secondsToTimestamp(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) * 1000));
  const hh = Math.floor(total / 3600000);
  const mm = Math.floor((total % 3600000) / 60000);
  const ss = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function parseSrt(filePath) {
  const blocks = String(fs.readFileSync(filePath, "utf8") || "").split(/\r?\n\s*\r?\n/gu);
  const rows = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
    const timeIndex = lines.findIndex((line) => /^\d\d:\d\d:\d\d,\d\d\d\s+-->\s+\d\d:\d\d:\d\d,\d\d\d$/u.test(line));
    if (timeIndex < 0) continue;
    const times = lines[timeIndex].match(/^(\d\d:\d\d:\d\d,\d\d\d)\s+-->\s+(\d\d:\d\d:\d\d,\d\d\d)$/u);
    if (!times) continue;
    const text = lines.slice(timeIndex + 1).join(" ").replace(/\s+/gu, " ").trim();
    if (!text) continue;
    const speaker = String(text.match(/^([^:]{1,80}):\s+/u)?.[1] || "").trim();
    rows.push({
      row: rows.length + 1,
      start: times[1],
      end: times[2],
      since: timestampToSeconds(times[1]),
      until: timestampToSeconds(times[2]),
      speaker,
      text,
    });
  }
  return rows;
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/^[-*\d.\s]+/u, "")
    .replace(/[.!?]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 120);
}

async function askOllama({ prompt, maxTokens = 900 }) {
  const host = String(process.env.OLLAMA_HOST || "http://mriczo:11434").replace(/\/+$/u, "");
  const json = await requestManagedOllamaChat({
    ollamaUrl: host,
    managerUrl: process.env.PYA_GPU_HOUSEKEEPER_URL || "",
    keepAlive: 180,
    think: false,
    options: { num_predict: maxTokens, temperature: 0.1 },
    messages: [
      { role: "system", content: "You identify question boundaries in a transcript. Return JSON only." },
      { role: "user", content: prompt },
    ],
    timeoutMs: Number(process.env.ANDRII_OLLAMA_TIMEOUT_MS || 300000),
  });
  return String(json?.message?.content || json?.response || "").trim();
}

function promptRows(rows) {
  return rows.map((row) => [
    `ROW ${row.row} | ${row.start} --> ${row.end} | ${row.speaker || "unknown"}`,
    row.text,
  ].join("\n")).join("\n");
}

function candidateQuestionRows(parsed, rows, minRow, maxRow) {
  const raw = Array.isArray(parsed?.questions) ? parsed.questions : [];
  const out = [];
  for (const item of raw) {
    const rowNumber = Number(item?.row ?? item?.row_index ?? item?.start_row);
    if (!Number.isInteger(rowNumber) || rowNumber < minRow || rowNumber > maxRow) continue;
    const row = rows[rowNumber - 1];
    if (!row) continue;
    const title = cleanTitle(item?.title || item?.topic || "");
    if (!title) continue;
    const kind = String(item?.kind || "moderator_question").trim().toLowerCase();
    if (!/(?:question|audience|moderator|prepared|opening|intro|closing|remarks)/u.test(kind)) continue;
    out.push({
      row: row.row,
      start: row.start,
      end: row.end,
      since: row.since,
      until: row.until,
      title,
      kind,
      confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : null,
    });
  }
  return out;
}

function dedupeBoundaries(boundaries) {
  const sorted = [...boundaries].sort((a, b) => a.since - b.since || a.row - b.row);
  const out = [];
  let openingSeen = false;
  let closingSeen = false;
  for (const candidate of sorted) {
    const kind = String(candidate.kind || "").toLowerCase();
    if (/^(?:opening|intro|remarks)/u.test(kind)) {
      if (openingSeen || closingSeen) continue;
      openingSeen = true;
    }
    if (/^closing/u.test(kind)) {
      if (closingSeen) continue;
      closingSeen = true;
    }
    const previous = out[out.length - 1];
    // A repeated “the question is ...” restatement belongs to the same chapter
    // when it occurs immediately after the original wording.
    const structural = /^(?:opening|intro|closing|remarks)/iu.test(String(candidate.kind || ""));
    const previousStructural = /^(?:opening|intro|closing|remarks)/iu.test(String(previous?.kind || ""));
    if (previous && !structural && !previousStructural && candidate.since - previous.since < 45) {
      if (candidate.title.length > previous.title.length) out[out.length - 1] = candidate;
      continue;
    }
    out.push(candidate);
  }
  return out;
}

function collapseConsecutiveRepeatedQuestionWording(boundaries, rows) {
  const out = [];
  let previousKey = "";
  let previousTitleKey = "";
  let previousContext = null;

  function questionTokens(text) {
    return String(text || "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/gu)
      .map((token) => token.trim())
      .filter((token) => token.length >= 2);
  }

  function moderatorContext(boundary) {
    const index = Number(boundary.row) - 1;
    const row = rows[index];
    if (!row) return null;
    const speaker = String(row.speaker || "").trim();
    const sameSpeakerPieces = [];
    const promptPieces = [];
    // Repeated panel prompts are often split across two diarization speakers
    // (for example, a moderator's short “Do you believe?” cue).  Gather the
    // same speaker's nearby rows and any nearby question-shaped rows so the
    // repeated question is compared by its full wording rather than by one
    // short sentence or an unstable diarization label.
    for (let cursor = Math.max(0, index - 4); cursor <= Math.min(rows.length - 1, index + 4); cursor += 1) {
      const nearby = rows[cursor];
      const text = String(nearby?.text || "");
      if (String(nearby?.speaker || "").trim() === speaker) sameSpeakerPieces.push(text);
      if (/[?]/u.test(text)
          || /\b(?:question\s+is|what\s+is|what\s+are|is\s+there|are\s+there|would\s+you|do\s+you|how\s+would|which\s+municipal|specific\s+municipal)\b/iu.test(text)) {
        promptPieces.push(text);
      }
    }
    const tokens = questionTokens((promptPieces.length ? promptPieces : sameSpeakerPieces).join(" "));
    return { speaker, tokens };
  }

  function repeatedContext(a, b, elapsedSeconds) {
    if (!a || !b) return false;
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds > 900) return false;
    if (a.tokens.length < 6 || b.tokens.length < 6) return false;
    const bSet = new Set(b.tokens);
    const shared = a.tokens.filter((token) => bSet.has(token)).length;
    const containment = shared / Math.min(a.tokens.length, b.tokens.length);
    return containment >= 0.72;
  }

  for (const boundary of [...(Array.isArray(boundaries) ? boundaries : [])].sort((a, b) => a.since - b.since || a.row - b.row)) {
    if (/^(?:opening|intro|closing|remarks)/iu.test(String(boundary.kind || ""))) {
      out.push(boundary);
      previousKey = "";
      previousTitleKey = "";
      continue;
    }
    const wording = String(rows[Number(boundary.row) - 1]?.text || "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const titleKey = String(boundary.title || "")
      .toLocaleLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .replace(/\s+/gu, " ")
      .trim();
    const context = moderatorContext(boundary);
    // Exact repeated moderator wording is strong evidence of one round even
    // when the model assigns different provisional titles to each repetition.
    // Short cues such as “Do you believe?” are deliberately excluded.
    // Consecutive identical provisional titles are a second, weaker signal:
    // the title can vary across LLM batches even when the moderator repeats
    // the same prompt before each candidate.
    if ((wording.length >= 30 && wording === previousKey)
        || (titleKey.length >= 12 && titleKey === previousTitleKey)
        || repeatedContext(previousContext, context, Number(boundary.since) - Number(out[out.length - 1]?.since))) continue;
    out.push(boundary);
    previousKey = wording.length >= 30 ? wording : "";
    previousTitleKey = titleKey.length >= 12 ? titleKey : "";
    previousContext = context;
  }
  return out;
}

async function mergeRepeatedQuestionBoundaries(boundaries, rows) {
  if (boundaries.length < 2) return boundaries;
  const listing = boundaries.map((boundary, index) => {
    const row = rows[boundary.row - 1];
    return `${index + 1}. row ${boundary.row} at ${boundary.start}: ${boundary.title}\n   wording: ${String(row?.text || "").slice(0, 500)}`;
  }).join("\n");
  const basePrompt = [
      "Review the proposed question and section boundaries below for a panel forum.",
      "Return exactly JSON: {\"keep\":[number],\"titles\":[{\"index\":number,\"title\":string}]}. Keep the first boundary of every distinct moderator or audience question round, plus the opening and closing section boundaries.",
      "A question round may contain several candidate answers, clarifications, and follow-up wording. Candidate answer continuations are not new questions, even when an answer contains a question mark, a topic phrase, or a candidate says they are addressing the issue further. If several proposed boundaries occur within one answer round, keep only the earliest real question boundary.",
      "The generated title is provisional and may be wrong; compare the actual wording/context rows. In a round-robin, the moderator may repeat the same question before each candidate. If two or more proposed boundaries have the same or near-identical moderator question wording, they are one question round: keep only the earliest boundary, regardless of their provisional titles.",
      "Do not split one round because the repeated wording mentions transit, housing, taxes, or another subtopic. A new boundary requires a materially new prompt introduced by the moderator or audience after the prior round has ended.",
      "A row is a real boundary only when the moderator or audience is introducing a new question to the panel. Do not create a boundary for a candidate's answer, a candidate's rhetorical question, a request to repeat a question, or an answer that mentions a related topic. In particular, consolidate a public-transit discussion into one round unless the moderator clearly introduces a separate question.",
      "Rewrite titles as neutral 3-10 word topic labels with no person names, moderator names, candidate names, or SPEAKER labels.",
      listing,
  ].join("\n\n");
  let response = await askOllama({
    maxTokens: 1400,
    prompt: basePrompt,
  });
  const parsed = parseJsonObjectFromModel(response);
  const keep = Array.isArray(parsed?.keep)
    ? parsed.keep.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1 && value <= boundaries.length)
    : [];
  const firstQuestionIndex = boundaries.findIndex((boundary) => !/^(?:opening|intro|closing|remarks)/iu.test(String(boundary.kind || ""))) + 1;
  const structurallyPlausible = keep.length >= Math.min(2, boundaries.length)
    && (!firstQuestionIndex || keep.includes(firstQuestionIndex));
  if (!structurallyPlausible) {
    // A truncated or over-aggressive adjudication must never collapse a
    // whole debate into one chapter. Retry with a shorter, explicit contract
    // that preserves at least the earliest question round and every distinct
    // prompt the model can substantively distinguish.
    response = await askOllama({
      maxTokens: 1400,
      prompt: [
        "Re-review these proposed panel question boundaries. The prior answer was unusable.",
        "Return JSON only: {\"keep\":[number],\"titles\":[{\"index\":number,\"title\":string}] }.",
        "Keep the earliest boundary of every materially different moderator or audience question. Keep repeated wording before each candidate as ONE round (retain its earliest index). Do not collapse unrelated questions into one, and do not omit the earliest question. Keep opening/closing section boundaries if present.",
        listing,
      ].join("\n\n"),
    });
  }
  const reviewed = parseJsonObjectFromModel(response);
  const reviewedKeep = Array.isArray(reviewed?.keep)
    ? reviewed.keep.map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 1 && value <= boundaries.length)
    : [];
  const finalKeep = reviewedKeep.length >= Math.min(2, boundaries.length)
    && (!firstQuestionIndex || reviewedKeep.includes(firstQuestionIndex))
    ? reviewedKeep
    : keep;
  if (finalKeep.length < Math.min(2, boundaries.length)
      || (firstQuestionIndex && !finalKeep.includes(firstQuestionIndex))) return collapseConsecutiveRepeatedQuestionWording(boundaries, rows);
  const titleMap = new Map();
  for (const item of (Array.isArray(reviewed?.titles) ? reviewed.titles : (Array.isArray(parsed?.titles) ? parsed.titles : []))) {
    const index = Number(item?.index);
    const title = cleanTitle(item?.title || "");
    if (Number.isInteger(index) && title) titleMap.set(index, title);
  }
  return collapseConsecutiveRepeatedQuestionWording([...new Set(finalKeep)].sort((a, b) => a - b).map((index) => ({
    ...boundaries[index - 1],
    title: titleMap.get(index) || boundaries[index - 1].title,
  })), rows);
}

async function main() {
  const transcriptDirArg = process.argv[2];
  const prefix = process.argv[3] || "meeting-qwen-auto-normalized";
  if (!transcriptDirArg) {
    usage();
    process.exit(2);
  }
  const transcriptDir = path.resolve(process.cwd(), transcriptDirArg);
  const speakerSrtPath = path.join(transcriptDir, `${prefix}.sentences.speaker.sentence.srt`);
  const mergedSrtPath = path.join(transcriptDir, `${prefix}.sentences.merged.srt`);
  const sourceSrtPath = fs.existsSync(speakerSrtPath) ? speakerSrtPath : mergedSrtPath;
  if (!fs.existsSync(sourceSrtPath)) throw new Error(`question-boundaries source SRT missing: ${sourceSrtPath}`);
  const rows = parseSrt(sourceSrtPath);
  if (!rows.length) throw new Error(`question-boundaries found no transcript rows in ${sourceSrtPath}`);

  const chunkRows = Math.max(60, Number(process.env.ANDRII_QUESTION_BATCH_ROWS || 160));
  const overlapRows = Math.min(40, Math.max(10, Math.floor(chunkRows / 5)));
  const candidates = [];
  for (let start = 0; start < rows.length; start += chunkRows - overlapRows) {
    const end = Math.min(rows.length, start + chunkRows);
    const batch = rows.slice(start, end);
    let parsed = null;
    let lastResponse = "";
    for (let attempt = 1; attempt <= 3 && !parsed; attempt += 1) {
      lastResponse = await askOllama({
        prompt: [
          "Review this transcript window and identify substantive questions that begin a new answer segment. Also identify the beginning of the panel's candidate opening statements and the beginning of the closing statements when those sections are present.",
          "Return exactly JSON: {\"questions\":[{\"row\":number,\"title\":string,\"kind\":string,\"confidence\":number}]}. Return an empty array when there is no substantive question or section boundary.",
          "Use the ROW number of the first row where the moderator or audience question actually begins, not a later answer or a repeated acknowledgement.",
          "Include prepared moderator questions addressed to all candidates and audience questions read to the panel. Ignore greetings, rhetorical questions inside an answer, requests to repeat a question, voting reminders, and the candidates' own rhetorical questions.",
          "If a question is restated, keep only its earliest wording. A question may span multiple rows; use the first row.",
          "For the opening section, return one boundary at the first candidate opening statement with kind opening and a neutral title such as Candidate Opening Statements. Do not create one boundary per candidate. For the closing section, return one boundary at the first closing statement with kind closing and a neutral title such as Candidate Closing Statements.",
          "Give each question a neutral 3-10 word topic title. The title must never contain a candidate's, moderator's, host's, or any other person's name, and must not turn a criticism into a fact.",
          `TRANSCRIPT WINDOW ROWS ${batch[0].row}-${batch[batch.length - 1].row}:`,
          promptRows(batch),
          lastResponse && attempt > 1 ? `Previous response was malformed; return JSON only. Previous response:\n${lastResponse}` : "",
        ].filter(Boolean).join("\n\n"),
      });
      parsed = parseJsonObjectFromModel(lastResponse);
    }
    if (!parsed) throw new Error(`question-boundaries model returned no JSON for rows ${batch[0].row}-${batch[batch.length - 1].row}`);
    candidates.push(...candidateQuestionRows(parsed, rows, batch[0].row, batch[batch.length - 1].row));
    process.stdout.write(`[question-boundaries] rows ${batch[0].row}-${batch[batch.length - 1].row}: ${candidateQuestionRows(parsed, rows, batch[0].row, batch[batch.length - 1].row).length} candidates\n`);
  }

  let boundaries = dedupeBoundaries(candidates);
  if (!boundaries.length) throw new Error("question-boundaries found no substantive questions; refusing to replace ordinary topic chapters");
  boundaries = await mergeRepeatedQuestionBoundaries(boundaries, rows);
  const payload = {
    schema: "andrii-question-boundaries-v1",
    source_srt: sourceSrtPath,
    generated_at: new Date().toISOString(),
    boundaries: boundaries.map((b) => ({
      row: b.row,
      start: b.start,
      end: b.end,
      since: b.since,
      until: b.until,
      title: b.title,
      kind: b.kind,
      confidence: b.confidence,
    })),
  };
  const jsonPath = path.join(transcriptDir, `${prefix}.question-boundaries.json`);
  const pyaPath = path.join(transcriptDir, `${prefix}.question-boundaries.pya`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  const lines = ["su name question boundaries artifact be series def"];
  for (const b of payload.boundaries) {
    lines.push(`su name question boundary ${b.row} since num ${Number(b.since).toFixed(3)} until num ${Number(b.until).toFixed(3)} ob text "${pyaEsc(JSON.stringify(b))}" ya`);
  }
  lines.push("prah");
  fs.writeFileSync(pyaPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`[question-boundaries] source: ${sourceSrtPath}\n`);
  process.stdout.write(`[question-boundaries] boundaries: ${boundaries.length}\n`);
  process.stdout.write(`[question-boundaries] wrote: ${jsonPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error?.message || error)}\n`);
  process.exit(1);
});
