#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { requestManagedOllamaChat } from "../../../../program/runtime/gpu/managed-ollama.mjs";
import { findAuthoritativeChapterFile, parseAuthoritativeChapterText } from "./chapter-timestamps.mjs";
import { buildCandidateAnswerCoverage } from "./candidate-answer-coverage.mjs";

function usage() {
  process.stdout.write("Usage: node program/segment-candidate-answers-from-transcript-folder.mjs <transcript_dir> [prefix]\n");
}

function pyaEsc(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function parseJsonObject(text) {
  const raw = String(text || "").trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/<think>[\s\S]*?<\/think>/giu, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function readRows(filePath) {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const source = Array.isArray(parsed) ? parsed : parsed?.rows;
  return (Array.isArray(source) ? source : []).map((row, index) => ({
    row: Number(row?.index || index + 1),
    since: Number(row?.since || 0),
    until: Number(row?.until || row?.since || 0),
    text: String(row?.text || row?.sentence || "").replace(/\s+/gu, " ").trim(),
    speaker_key: String(row?.speaker_key || row?.display || "").trim(),
  })).filter((row) => row.text);
}

function cleanName(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readNormalizationMap(transcriptDir, prefix) {
  const filePath = path.join(transcriptDir, `${prefix}.normalize.metadata.json`);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed?.string_replacement_map && typeof parsed.string_replacement_map === "object"
      ? parsed.string_replacement_map : {};
  } catch {
    return {};
  }
}

function inferCanonicalLocation(rows, replacements) {
  // Use a canonical location already present in the normalized evidence. This
  // keeps summary cleanup profile-driven: a noisy proper-name variant is only
  // corrected when the same location is independently present in the source.
  const values = [...new Set(Object.values(replacements)
    .map((value) => cleanName(value))
    .filter((value) => value.split(/\s+/u).length >= 2))];
  const source = rows.map((row) => row.text).join(" ");
  const ranked = values.map((value) => ({
    value,
    count: (source.match(new RegExp(`\\b${value.split(/\s+/u).map(escapeRegex).join("\\s+")}\\b`, "giu")) || []).length,
  })).filter((item) => item.count > 0).sort((a, b) => b.count - a.count);
  return ranked[0]?.value || "";
}

function normalizeCandidateSummary(summary, replacements, canonicalLocation) {
  let output = String(summary || "").replace(/\s+/gu, " ").trim();
  const entries = Object.entries(replacements || {})
    .map(([observed, canonical]) => [cleanName(observed), cleanName(canonical)])
    .filter(([observed, canonical]) => observed && canonical && observed.toLocaleLowerCase() !== canonical.toLocaleLowerCase())
    .sort((a, b) => b[0].length - a[0].length);
  for (const [observed, canonical] of entries) {
    output = output.replace(new RegExp(`\\b${escapeRegex(observed)}\\b`, "giu"), canonical);
  }
  if (canonicalLocation) {
    const locationParts = canonicalLocation.split(/\s+/u);
    const finalToken = locationParts.at(-1);
    const escapedFinal = escapeRegex(finalToken);
    const escapedCanonical = escapeRegex(canonicalLocation);
    // If the source establishes one canonical “X Sound” location, normalize a
    // different capitalized “Y Sound” rendering without touching ordinary
    // uses of the word “sound” or changing a location absent from evidence.
    if (locationParts.length === 2 && finalToken.toLocaleLowerCase() === "sound") {
      output = output.replace(new RegExp(`\\b(?!${escapedCanonical}\\b)[A-Z][\\p{L}'-]*\\s+${escapedFinal}\\b`, "gu"), canonicalLocation);
    }
  }
  return output;
}

function isThirdPersonCandidateReference(text, canonicalName) {
  const value = cleanName(text);
  const name = cleanName(canonicalName);
  const tokens = name.split(/\s+/u).filter((token) => token.length >= 3);
  if (!value || !tokens.length || !tokens.every((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "iu").test(value);
  })) return false;
  if (/\b(?:my name is|i(?:'m| am)|this is|next up|first up|second will|third will|fourth will|fifth will|sixth will|go to|will be|from)\b/iu.test(value)) return false;
  const escapedName = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+");
  return new RegExp(`${escapedName}['’]s?`, "iu").test(value)
    || new RegExp(`\\b(?:idea|proposal|plan|position|approach|comments?|statement|view|views)\\s+(?:of|from|by)\\s+${escapedName}`, "iu").test(value)
    || new RegExp(`\\b(?:agrees? with|disagrees? with|mentions?|references?|criticizes?|criticised|supports?)\\s+${escapedName}`, "iu").test(value);
}

// Moderators sometimes call on a candidate with a comma-separated name cue
// (“Ray, Bob, you go ahead”).  Normalize the cue before roster resolution so
// a noisy surname can still resolve through a unique first name or alias.
function goAheadNameCallout(text) {
  const value = cleanName(text);
  const token = "[\\p{L}][\\p{L}.'-]*";
  const match = value.match(new RegExp(`^\\s*((?:${token}\\s*,\\s*){0,2}${token})\\s*,\\s*(?:you\\s+)?(?:go|are|were)\\s+ahead\\b`, "iu"))
    || value.match(new RegExp(`^\\s*(${token})\\s+(?:you\\s+)?(?:go|are|were)\\s+ahead\\b`, "iu"));
  const name = match?.[1] ? match[1].replace(/[,/:]/gu, " ").replace(/\\s+/gu, " ").trim() : "";
  return /^(?:and\\s+)?(?:next|now)$/iu.test(name) ? "" : name;
}

function hasStructuralHandoffCue(text) {
  const value = cleanName(text);
  return Boolean(goAheadNameCallout(value))
    || /^(?:and\s+)?(?:next|first|second|third|fourth|fifth|sixth)\s+(?:up|will|to|answer|question)\b/iu.test(value)
    || /^(?:and\s+)?(?:next|now)\s*,?\s*(?:we\s+have|is|we're\s+going\s+to)\b/iu.test(value)
    || /^(?:and\s+)?(?:next|now)\s*,?\s+[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,3}[.!?]?$/u.test(value)
    || /^(?:and\s+)?(?:next|now)\s*,?\s+(?:go\s+ahead\s*,?\s*|please\s+)?[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,3}[.!?]?$/iu.test(value)
    || /\b(?:next|following)\s+(?:answer|candidate|speaker)\b/iu.test(value)
    || /\b(?:go|start)\s+(?:to|with)\b/iu.test(value)
    || /\b(?:start(?:ing)?|begin(?:ning)?)\s+(?:again\s+)?with\s+[\p{L}][\p{L}.'-]*/iu.test(value)
    || /\b(?:you (?:are|were) up|work our way)\b/iu.test(value)
    || /^(?:thank you|thanks)[,.]?\s*(?:(?:mr|ms|mrs|councillor|councilor)\.?\s+)?[\p{L}]/iu.test(value)
    || /\b(?:will be|we will go to|we're going to go to)\b/iu.test(value);
}

// A combined closing/next-turn cue such as “Thank you, Andres Vorgan,
// Carol Merton” identifies the final named candidate as the next speaker.
// A lone thank-you remains a turn close and does not create a handoff.
function candidateAfterMultiNameThankYou(text, candidates = [], aliases = []) {
  const value = cleanName(text);
  if (!/^(?:thank you|thanks)\b/iu.test(value)) return "";
  const variants = [
    ...(Array.isArray(candidates) ? candidates : []).map((candidate) => ({ observed: cleanName(candidate), canonical: cleanName(candidate) })),
    ...(Array.isArray(aliases) ? aliases : []).map((alias) => ({ observed: cleanName(alias?.observed), canonical: cleanName(alias?.canonical_name) })),
  ].filter((variant) => variant.observed && variant.canonical);
  const matches = [];
  for (const variant of variants.sort((a, b) => b.observed.length - a.observed.length)) {
    const escaped = variant.observed.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const at = value.search(new RegExp(`\\b${escaped}\\b`, "iu"));
    if (at >= 0) matches.push({ canonical: variant.canonical, at });
  }
  const ordered = [...new Map(matches.sort((a, b) => a.at - b.at).map((match) => [match.canonical.toLocaleLowerCase(), match])).values()];
  return ordered.length >= 2 ? ordered.at(-1).canonical : "";
}

// Some moderators use a bare name cue between answers (for example,
// “Julie King.”).  It is only a handoff when the short cue contains a
// surname belonging to exactly one verified roster candidate; the alias map
// then supplies the LLM-adjudicated canonical spelling.
function looksLikeBareNameCallout(text, candidates = [], aliases = []) {
  const value = cleanName(text).replace(/[.!?,;:]+$/u, "");
  if (!value || value.length > 80 || /[?;]/u.test(value)) return false;
  if (/^(?:keep|thank(?:\s+you)?|thanks)\b/iu.test(value)) return false;
  if (!/^[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,3}$/u.test(value)) return false;
  const people = [
    ...(Array.isArray(candidates) ? candidates.map((candidate) => ({ canonical_name: candidate })) : []),
    ...(Array.isArray(aliases) ? aliases : []),
  ];
  const surnames = new Map();
  for (const person of people) {
    const canonical = cleanName(person?.canonical_name);
    const surname = canonical.split(/\s+/u).filter(Boolean).at(-1);
    if (!surname) continue;
    const escaped = surname.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "iu").test(value)) {
      const key = cleanName(person?.canonical_name).toLocaleLowerCase();
      if (key) surnames.set(key, cleanName(person?.canonical_name));
    }
  }
  return surnames.size === 1;
}

function readSpeakerMap(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return {}; }
}

function canonicalCandidates(map) {
  return (Array.isArray(map?.roster) ? map.roster : [])
    .filter((person) => person?.role === "candidate")
    .map((person) => cleanName(person?.canonical_name))
    .filter(Boolean);
}

function buildRowIdentity(rows, map) {
  const byRow = new Map();
  for (const span of Array.isArray(map?.spans) ? map.spans : []) {
    const start = Number(span?.start_row);
    const end = Number(span?.end_row);
    const confidence = Number(span?.confidence || 0);
    const name = cleanName(span?.canonical_name);
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start || !name) continue;
    for (let row = start; row <= end; row += 1) {
      const prior = byRow.get(row);
      if (!prior || confidence > prior.confidence) {
        byRow.set(row, { name, role: String(span?.role || ""), confidence });
      }
    }
  }
  // Authoritative opening/closing spans provide a speaker-key anchor even
  // when the diarizer later creates a new key or the LLM linker lets a span
  // overrun the next candidate. Use only a dominant, substantive key from a
  // verified opening span; never infer identity from sitting order or a raw
  // key that has no anchored evidence.
  const anchoredKeys = new Map();
  for (const span of Array.isArray(map?.spans) ? map.spans : []) {
    if (span?.role !== "candidate" || Number(span?.confidence || 0) < 0.99 || Number(span?.start_row) > 220) continue;
    const counts = new Map();
    for (const row of rows) {
      if (row.row < Number(span.start_row) || row.row > Number(span.end_row) || isControlOrQuestion(row.text)) continue;
      if (row.speaker_key) counts.set(row.speaker_key, (counts.get(row.speaker_key) || 0) + 1);
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    if (!ranked.length || ranked[0][1] < 3 || (ranked[1] && ranked[0][1] === ranked[1][1])) continue;
    const key = ranked[0][0];
    const prior = anchoredKeys.get(key);
    if (prior && prior.name !== cleanName(span.canonical_name)) continue;
    anchoredKeys.set(key, { name: cleanName(span.canonical_name), confidence: 0.99 });
  }
  for (const row of rows) {
    const anchored = anchoredKeys.get(row.speaker_key);
    const prior = byRow.get(row.row);
    // An anchored raw key is only a gap-filler. It must never overwrite an
    // explicit named-handoff span, even when that span has confidence .98:
    // short panels often reuse one diarization key across moderator and
    // candidate turns.
    if (!anchored || prior) continue;
    byRow.set(row.row, { name: anchored.name, role: "candidate", confidence: anchored.confidence });
  }
  return byRow;
}

function isControlOrQuestion(text) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  return Boolean(goAheadNameCallout(value))
    || /^(?:the question\b|question(?: is|:)|for this next question|next up\b|and next\b|(?:next|now)\s*,?\s*(?:we\s+have|is)\b|first up\b|second will\b|third will\b|fourth will\b|fifth will\b|sixth will\b|our next\b|we(?:'re| are| will) going\b|we(?:'ll| will) start\b|please\b|let(?:'s| us)\b|time-wise\b|before i\b|each candidate\b|we have\b|thank you(?:[,.]|$)|all right\b|okay[,.]?\s*(?:thank|next|we)\b|(?:mr|ms|miss|councillor)\.?\s+[^,]+,?\s+could you repeat\b)/iu.test(value)
    || /\b(?:the question is|for this next question|(?:we(?:'ll| will)\s+)?move\s+on\s+to\s+the\s+next\s+question|when we do closing remarks|could you repeat the question)\b/iu.test(value)
    || /\b(?:i(?:'ll| will)\s+read\s+(?:that|this)|while\s+you(?:'re| are)\s+looking|one\s+more\s+time(?:\s+here)?|you(?:'re| are)\s+(?:looking|going)\s+through\s+your\s+notes|may\s+not\s+have\s+it\s+in\s+front)\b/iu.test(value)
    || /^(?:so\s+)?we\s+have\s*:\s*.+\?\s*$/iu.test(value)
    || /\?\s*$/u.test(value);
}

function handoffCandidateFromText(text, candidates, aliases = []) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  const multiThankYouCandidate = candidateAfterMultiNameThankYou(value, candidates, aliases);
  if (multiThankYouCandidate) return multiThankYouCandidate;
  if (/^(?:keep|thank(?:\s+you)?|thanks)\b/iu.test(value)
      && !/\b(?:next|now|first|second|third|fourth|fifth|sixth)\b/iu.test(value)) return "";
  // A named “Thank you, Candidate” row closes the preceding answer; it is
  // not evidence that the thanked candidate is about to speak. Only a
  // structural handoff (or a bounded bare-name cue) may establish the next
  // candidate, otherwise the preceding candidate is incorrectly carried into
  // the following answer.
  const hasHandoffCue = hasStructuralHandoffCue(value)
    || /\bthat was\b/iu.test(value);
  if (!hasHandoffCue && !looksLikeBareNameCallout(value, candidates, aliases)) return "";
  const goAhead = goAheadNameCallout(value);
  const inlineNext = value.match(/\b(?:next|now)(?:\s*,?\s+(?:we\s+have|is)\s+|\s*,\s*(?:go\s+ahead\s*,?\s*|please\s+)?)([\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,3})[.!?]?$/iu);
  const handoffValue = goAhead || (inlineNext?.[1] ? cleanName(inlineNext[1]) : value);
  const variants = [];
  const firstNames = new Map();
  for (const candidate of candidates) {
    const firstName = candidate.split(/\s+/u)[0]?.toLocaleLowerCase();
    if (!firstName) continue;
    firstNames.set(firstName, (firstNames.get(firstName) || 0) + 1);
  }
  for (const candidate of candidates) {
    variants.push({ observed: candidate, canonical: candidate });
    const surname = candidate.split(/\s+/u).at(-1);
    if (surname && surname.length >= 4) variants.push({ observed: surname, canonical: candidate });
    const firstName = candidate.split(/\s+/u)[0];
    if (firstName && firstName.length >= 3 && firstNames.get(firstName.toLocaleLowerCase()) === 1) {
      variants.push({ observed: firstName, canonical: candidate });
    }
  }
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const observed = cleanName(alias?.observed);
    const canonical = cleanName(alias?.canonical_name);
    if (observed && canonical) variants.push({ observed, canonical });
  }
  for (const variant of variants.sort((a, b) => b.observed.length - a.observed.length)) {
    const tokens = variant.observed.split(/\s+/u).filter((token) => token.length >= 3);
    if (tokens.length && tokens.every((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\\\$&")}\\b`, "iu").test(handoffValue))) {
      return variant.canonical;
    }
  }
  return "";
}

function isHandoffCue(text) {
  return hasStructuralHandoffCue(text) || /\b(?:that was|thank you)\b/iu.test(String(text || ""));
}

function findHandoffs(rows, map, candidates) {
  const aliases = Array.isArray(map?.aliases) ? map.aliases : [];
  return rows.map((row) => ({
    row: row.row,
    candidate: handoffCandidateFromText(row.text, candidates, aliases),
    text: row.text,
  })).filter((handoff) => handoff.candidate || isHandoffCue(handoff.text));
}

function secondsToTimestamp(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = Math.floor(total / 3600);
  const mm = Math.floor((total % 3600) / 60);
  const ss = total % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}

async function askOllama({ prompt, maxTokens = 1100 }) {
  const host = String(process.env.OLLAMA_HOST || "http://mriczo:11434").replace(/\/+$/u, "");
  const response = await requestManagedOllamaChat({
    ollamaUrl: host,
    managerUrl: process.env.PYA_GPU_HOUSEKEEPER_URL || "",
    keepAlive: 180,
    think: false,
    options: { num_predict: maxTokens, temperature: 0.1 },
    messages: [
      { role: "system", content: "You segment and summarize candidate answers from a civic forum transcript. Return JSON only." },
      { role: "user", content: prompt },
    ],
    timeoutMs: Number(process.env.ANDRII_OLLAMA_TIMEOUT_MS || 300000),
  });
  return String(response?.message?.content || response?.response || "").trim();
}

async function summarizeCandidateAnswer(candidate, questionTitle, sourceText) {
  const source = String(sourceText || "").replace(/\s+/gu, " ").trim();
  if (!source) return "";
  const response = await askOllama({
    maxTokens: 420,
    prompt: [
      `Write a neutral, source-faithful one- or two-sentence summary of ${candidate}'s answer to "${questionTitle}".`,
      "Attribute proposals and criticism to the candidate; do not infer outcomes, motives, or agreement.",
      "If the source contains an initial answer and a later follow-up, cover the initial answer first and include any material follow-up; do not summarize only the final block.",
      "Return only the summary, with no heading, preamble, or quotation marks.",
      `SOURCE: ${source}`,
    ].join("\n\n"),
  });
  return response.replace(/^```(?:text)?\s*/iu, "").replace(/\s*```$/u, "").replace(/^summary:\s*/iu, "").trim().slice(0, 900);
}

async function splitAtReviewedBoundaries(answers, window, rows) {
  const boundaries = (Array.isArray(window.reviewedBoundaries) ? window.reviewedBoundaries : [])
    .map((range) => Number(range.start_row))
    .filter((row) => Number.isInteger(row));
  if (!boundaries.length) return answers;
  const output = [];
  for (const answer of answers) {
    const cuts = boundaries.filter((row) => row > answer.start_row && row <= answer.end_row).sort((a, b) => a - b);
    if (!cuts.length) {
      output.push(answer);
      continue;
    }
    const starts = [answer.start_row, ...cuts];
    const ends = [...cuts.map((row) => row - 1), answer.end_row];
    for (let index = 0; index < starts.length; index += 1) {
      const start = starts[index];
      const end = ends[index];
      const sourceRows = rows.filter((row) => row.row >= start && row.row <= end && !isControlOrQuestion(row.text));
      if (!sourceRows.length) continue;
      const sourceText = sourceRows.map((row) => row.text).join(" ").replace(/\s+/gu, " ").trim();
      const first = sourceRows[0];
      const last = sourceRows.at(-1);
      const summary = await summarizeCandidateAnswer(answer.candidate, window.title, sourceText);
      if (!summary) continue;
      output.push({
        ...answer,
        start_row: first.row,
        end_row: last.row,
        since: Number(first.since || 0),
        until: Number(last.until || first.until || 0),
        source_text: sourceText,
        summary,
        confidence: Math.min(Number(answer.confidence || 0.82), 0.98),
      });
    }
  }
  return output;
}

function rowLabel(row, identity) {
  const person = identity.get(row.row);
  const label = person ? `${person.role}:${person.name}` : `raw:${row.speaker_key || "unknown"}`;
  return `ROW ${row.row} | ${row.since.toFixed(3)} --> ${row.until.toFixed(3)} | ${label}\n${row.text}`;
}

function questionWindows(rows, boundaries) {
  const sorted = (Array.isArray(boundaries) ? boundaries : [])
    .filter((item) => String(item?.kind || "").toLowerCase().includes("question"))
    .sort((a, b) => Number(a.row) - Number(b.row));
  return sorted.map((boundary, index) => {
    const start = Math.max(1, Number(boundary.row) || 1);
    const next = sorted[index + 1];
    const end = Math.min(rows.length, next ? Number(next.row) - 1 : rows.length);
    return {
      question_id: `question_${String(index + 1).padStart(2, "0")}`,
      title: cleanName(boundary.title) || `Question ${index + 1}`,
      start_row: start,
      end_row: Math.max(start, end),
    };
  });
}

function officialQuestionWindows(transcriptDir, prefix, rows) {
  const chapterPath = findAuthoritativeChapterFile(transcriptDir, prefix);
  if (!chapterPath) return [];
  let chapters = [];
  try { chapters = parseAuthoritativeChapterText(fs.readFileSync(chapterPath, "utf8")); } catch { return []; }
  const questionChapters = chapters.filter((chapter) => /^(?:(?:audience)\s+)?q\s*:/iu.test(String(chapter.title || ""))
    || /^question\s*:/iu.test(String(chapter.title || "")));
  if (!questionChapters.length) return [];
  return questionChapters.map((chapter, index) => {
    const next = questionChapters[index + 1] || chapters.find((candidate) => candidate.since > chapter.since && /^(?:closing|moderator(?:'s)?\s+closing)/iu.test(candidate.title));
    const startRow = rows.find((row) => row.since >= chapter.since)?.row || rows.length;
    const endRow = next
      ? Math.max(startRow, (rows.find((row) => row.since >= next.since)?.row || rows.length) - 1)
      : rows.length;
    return {
      question_id: `question_${String(index + 1).padStart(2, "0")}`,
      title: cleanName(String(chapter.title || "").replace(/^(?:(?:audience)\s+)?q\s*:\s*/iu, "").replace(/^question\s*:\s*/iu, "")),
      start_row: startRow,
      end_row: Math.min(rows.length, endRow),
      // Audience prompts may not receive a response from every panelist
      // before the moderator moves on. Keep their coverage visible, but do
      // not force a fabricated slot unless an operator explicitly enables
      // PYA_CANDIDATE_ANSWER_REQUIRE_EACH=1.
      coverage_required: !/^audience\s+q\s*:/iu.test(String(chapter.title || "")),
      source: "authoritative-chapters",
    };
  }).filter((window) => window.end_row >= window.start_row);
}

function officialAnswerWindows(transcriptDir, prefix, rows, candidates) {
  const chapterPath = findAuthoritativeChapterFile(transcriptDir, prefix);
  if (!chapterPath) return [];
  let chapters = [];
  try { chapters = parseAuthoritativeChapterText(fs.readFileSync(chapterPath, "utf8")); } catch { return []; }
  const out = [];
  for (let index = 0; index < chapters.length; index += 1) {
    const chapter = chapters[index];
    const match = String(chapter.title || "").match(/^(?:opening|closing):\s*(.+)$/iu);
    if (!match) continue;
    const candidate = validCandidateName(match[1], candidates);
    if (!candidate) continue;
    const next = chapters[index + 1];
    const startRow = rows.find((row) => row.since >= chapter.since)?.row || rows.length;
    const endRow = next
      ? Math.max(startRow, (rows.find((row) => row.since >= next.since)?.row || rows.length) - 1)
      : rows.length;
    out.push({
      question_id: `${/^opening:/iu.test(chapter.title) ? "opening" : "closing"}_${String(index + 1).padStart(2, "0")}`,
      title: chapter.title,
      start_row: startRow,
      end_row: Math.min(rows.length, endRow),
      expected_candidate: candidate,
    });
  }
  return out;
}

function answerPrompt(window, rows, identity, candidates, repairCandidates = [], requireComplete = false) {
  const windowRows = rows.filter((row) => row.row >= window.start_row && row.row <= window.end_row);
  const unverifiedNameCues = windowRows
    .filter((row) => /\b(?:mr|ms|mrs|councillor|councilor)\.?\s+[\p{L}][\p{L}.'-]*/iu.test(row.text)
      && identity.get(row.row)?.role !== "moderator")
    .map((row) => `${row.row}: ${row.text}`)
    .join("\n");
  return [
    "Identify every distinct candidate answer in this one question window.",
    "The moderator often calls a candidate by name immediately before the answer. Treat that callout and the following candidate speech as primary identity evidence; raw diarization labels are only supporting evidence.",
    "Return exactly JSON: {\"answers\":[{\"candidate\":string,\"start_row\":number,\"end_row\":number,\"handoff_row\":number|null,\"summary\":string,\"confidence\":number}]}",
    `QUESTION: ${window.title}`,
    `WINDOW ROWS: ${window.start_row}-${window.end_row}`,
    `CANONICAL CANDIDATES: ${candidates.join("; ")}`,
    repairCandidates.length
      ? `COVERAGE REPAIR: the prior pass did not produce verified timeslots for ${repairCandidates.join("; ")}. Re-read the entire window and return a grounded answer object for each of these candidates if their answer is present. A missing slot will keep the job retryable; do not fill a slot with the moderator's question or a handoff.`
      : "",
    repairCandidates.length === 1
      ? `TARGET CANDIDATE: locate exactly one contiguous answer by ${repairCandidates[0]} in this window and return that one answer object. Do not substitute another candidate.`
      : "",
    requireComplete && !repairCandidates.length
      ? "COMPLETE-ROUND CONTRACT: this is a full candidate-response round. Return one grounded answer object for every canonical candidate in the roster. Use answer order, moderator callouts, contiguous speech, and the candidate's own wording together; do not omit a candidate solely because the raw diarization key is unreliable."
      : "",
    window.expected_candidate ? `EXPECTED CANDIDATE FOR THIS NAMED SECTION: ${window.expected_candidate}` : "",
    window.handoffs?.length
      ? `EXPLICIT MODERATOR HANDOFFS (row -> candidate or ASR wording): ${window.handoffs.map((handoff) => `${handoff.row} -> ${handoff.candidate || handoff.text}`).join("; ")}`
      : "",
    window.reviewedBoundaries?.length
      ? `OPERATOR-REVIEWED IDENTITY RANGES — preserve each as its own answer boundary even when the candidate name is unchanged: ${window.reviewedBoundaries.map((range) => `${range.start_row}-${range.end_row} ${range.canonical_name}`).join("; ")}`
      : "",
    unverifiedNameCues
      ? `NAME CUES NOT VERIFIED AS MODERATOR SPEECH — do not treat these as handoffs without corroborating continuity:\n${unverifiedNameCues}`
      : "",
    "Rules:",
    "- Use only a canonical candidate name from the roster.",
    "- Normalize phonetic ASR names in a callout or self-introduction to the closest canonical roster name only when the handoff and answer continuity support it (for example, an ASR name that is clearly Andrii Zvorygin).",
    "- A sentence that mentions another candidate in the third person (for example, 'Carol Merton's idea of housing first') is not a handoff and is not evidence that Carol is speaking. Do not assign the answer to the person being mentioned.",
    "- If a candidate's answer continues across diarizer-key changes, preserve the preceding candidate identity until a moderator or audience handoff clearly starts another answer. Do not treat a short noisy cue inside the candidate's own block as a new handoff.",
    "- start_row is the first sentence actually spoken by that candidate, never the moderator's question, name callout, acknowledgement, or instruction.",
    "- end_row is the last sentence of that answer before another candidate or moderator takes over.",
    "- Do not label a repeated question, a request to repeat the question, or a handoff as an answer.",
    "- If a candidate returns later in the same question after a real interruption, return a separate answer object.",
    "- Preserve an operator-reviewed identity range as a separate answer object when it begins inside another candidate block; do not merge across that reviewed boundary.",
    "- Write a neutral, source-faithful 1-2 sentence summary of only that answer. Preserve disagreement as attributed opinion; do not add facts.",
    "- The window may contain an initial answer followed by a moderator follow-up. Summarize the complete response: lead with the initial answer's main position and concrete proposals, then include any material follow-up or correction. Never summarize only the final follow-up block.",
    requireComplete
      ? "- Return exactly one grounded answer object for every canonical candidate in this question round. Do not omit a candidate merely because the diarizer key is unreliable: use the moderator's named handoff, contiguous answer block, answer order explicitly spoken in the transcript, and the candidate's own wording together as evidence. Do not invent prose or use the moderator's question as an answer."
      : "- Omit uncertain answers rather than guessing.",
    "TRANSCRIPT:",
    windowRows.map((row) => rowLabel(row, identity)).join("\n"),
  ].join("\n\n");
}

function validCandidateName(value, candidates) {
  const name = cleanName(value).toLocaleLowerCase();
  return candidates.find((candidate) => candidate.toLocaleLowerCase() === name) || "";
}

function sanitizeAnswer(raw, window, rows, identity, candidates, allowLlmIdentityFallback = false) {
  const rawStart = Number(raw?.start_row);
  const recentHandoff = (Array.isArray(window.handoffs) ? window.handoffs : [])
    .filter((handoff) => handoff.candidate && handoff.row <= rawStart && rawStart - handoff.row <= 12)
    .at(-1);
  const genericHandoff = (Array.isArray(window.handoffs) ? window.handoffs : [])
    .filter((handoff) => handoff.row <= rawStart && rawStart - handoff.row <= 12)
    .at(-1);
  const linkedStart = rows.find((row) => row.row === rawStart && identity.get(row.row)?.role === "candidate")
    || rows.find((row) => row.row >= rawStart && row.row <= rawStart + 3 && identity.get(row.row)?.role === "candidate");
  const linkedCandidate = linkedStart ? identity.get(linkedStart.row)?.name : "";
  const candidate = recentHandoff?.candidate || linkedCandidate || validCandidateName(raw?.candidate, candidates);
  if (window.expected_candidate && candidate.toLocaleLowerCase() !== window.expected_candidate.toLocaleLowerCase()) return null;
  let start = Number(raw?.start_row);
  let end = Number(raw?.end_row);
  if (!candidate || !Number.isInteger(start) || !Number.isInteger(end)) return null;
  start = Math.max(window.start_row, Math.min(window.end_row, start));
  end = Math.max(start, Math.min(window.end_row, end));
  const scoped = rows.filter((row) => row.row >= start && row.row <= end);
  let candidateRows = scoped.filter((row) => {
    const person = identity.get(row.row);
    return person?.role === "candidate" && person.name.toLocaleLowerCase() === candidate.toLocaleLowerCase() && !isControlOrQuestion(row.text);
  });
  // A moderator may insert a short clarification after the candidate has
  // already begun answering. If the answer model starts at the sentence
  // after that clarification, recover the earlier evidence-backed candidate
  // cues from the same explicit handoff so the subchapter begins at the true
  // answer start rather than at the resumed sentence.
  if (recentHandoff?.candidate
      && recentHandoff.candidate.toLocaleLowerCase() === candidate.toLocaleLowerCase()
      && candidateRows.length) {
    const firstSelected = candidateRows[0].row;
    const preceding = rows.filter((row) => row.row > recentHandoff.row
      && row.row < firstSelected
      && identity.get(row.row)?.role === "candidate"
      && identity.get(row.row)?.name?.toLocaleLowerCase() === candidate.toLocaleLowerCase()
      && !isControlOrQuestion(row.text));
    if (preceding.length) candidateRows = [...preceding, ...candidateRows];
  }
  if (!candidateRows.length && candidate && genericHandoff && !genericHandoff.candidate
      && scoped.some((row) => /\b(?:my\s+name\s+is|i(?:'m| am)|this is)\b/iu.test(row.text))) {
    // Allow an LLM-normalized self-introduction to establish identity when
    // the diarizer has no usable span for that answer yet.
    candidateRows = scoped.filter((row) => row.row >= start && !isControlOrQuestion(row.text));
  }
  if (!candidateRows.length && allowLlmIdentityFallback) {
    // When the diarizer has collapsed two panelists into one raw key, the
    // answer model can still identify a candidate from the named handoff,
    // answer order, and the full transcript window. Accept that model-grounded
    // range only when no verified span for a different candidate contradicts
    // it; never use this path to overwrite an explicit linked identity.
    const conflictingRows = scoped.filter((row) => {
      const person = identity.get(row.row);
      return person?.role === "candidate" && person.name.toLocaleLowerCase() !== candidate.toLocaleLowerCase();
    });
    const namedEvidence = (Array.isArray(window.handoffs) ? window.handoffs : [])
      .some((handoff) => handoff.candidate?.toLocaleLowerCase() === candidate.toLocaleLowerCase()
        && handoff.row <= start && start - handoff.row <= 40);
    const selfEvidence = scoped.some((row) => /\b(?:my\s+name\s+is|i(?:'m| am)|this is)\b/iu.test(row.text));
    const substantive = scoped.filter((row) => !isControlOrQuestion(row.text));
    const handoffBoundary = rows.some((row) => row.row < start && row.row >= start - 3 && isControlOrQuestion(row.text));
    const overrunOnly = conflictingRows.length > 0
      && conflictingRows.every((row) => {
        const person = identity.get(row.row);
        return person && Number(person.confidence || 0) < 1 && row.row < start;
      });
    if ((!conflictingRows.length || handoffBoundary || overrunOnly)
      && substantive.length
      && (namedEvidence || selfEvidence || Number(raw?.confidence || 0) >= 0.75)) {
      candidateRows = substantive;
    }
  }
  if (!candidateRows.length) return null;
  const firstCandidateRow = rows.find((row) => row.row === start) || candidateRows[0];
  if (!recentHandoff?.candidate
      && isThirdPersonCandidateReference(firstCandidateRow?.text, candidate)
      && !/\b(?:my name is|i(?:'m| am)|this is)\b/iu.test(firstCandidateRow?.text || "")) {
    // The answer starts by referring to another candidate. Without a direct
    // handoff or self-identification this is unsafe identity evidence; do not
    // publish a chapter that turns the named subject into the speaker.
    return null;
  }
  // Do not let an LLM-selected handoff or repeated question become the
  // timestamp. Move to the first verified candidate sentence in the range.
  start = candidateRows[0].row;
  end = candidateRows.at(-1).row;
  const source = candidateRows.map((row) => row.text).join(" ").replace(/\s+/gu, " ").trim();
  if (!source) return null;
  const first = rows.find((row) => row.row === start);
  const last = rows.find((row) => row.row === end) || first;
  return {
    candidate,
    start_row: start,
    end_row: end,
    since: Number(first?.since || 0),
    until: Number(last?.until || first?.until || 0),
    handoff_row: recentHandoff?.row || genericHandoff?.row || (Number.isInteger(Number(raw?.handoff_row)) ? Number(raw.handoff_row) : null),
    summary: String(raw?.summary || "").replace(/\s+/gu, " ").trim().slice(0, 900),
    confidence: Math.max(0, Math.min(1, Number(raw?.confidence || 0))),
    source_text: source,
  };
}

function dedupeAnswers(answers) {
  const sorted = [...answers].sort((a, b) => a.start_row - b.start_row || a.end_row - b.end_row);
  const out = [];
  for (const answer of sorted) {
    const previous = out.at(-1);
    if (previous && previous.candidate === answer.candidate && answer.start_row <= previous.end_row + 1) {
      previous.end_row = Math.max(previous.end_row, answer.end_row);
      previous.until = Math.max(previous.until, answer.until);
      previous.source_text = `${previous.source_text} ${answer.source_text}`.replace(/\s+/gu, " ").trim();
      if (answer.summary.length > previous.summary.length) previous.summary = answer.summary;
      continue;
    }
    out.push(answer);
  }
  return out;
}

function evidenceAnswerFallbacks(window, rows, identity, candidates, handoffs) {
  const output = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const candidateRows = rows.filter((row) => row.row >= window.start_row
      && row.row <= window.end_row
      && identity.get(row.row)?.role === "candidate"
      && identity.get(row.row)?.name?.toLocaleLowerCase() === candidate.toLocaleLowerCase()
      && !isControlOrQuestion(row.text));
    if (!candidateRows.length) continue;
    // Keep distinct answer blocks separate when another candidate speaks in
    // between. Moderator clarifications and thank-you cues alone do not split
    // a block, so a candidate who resumes after a short interruption remains
    // one subchapter; a later follow-up after another candidate is separate.
    const blocks = [];
    let block = [];
    for (const row of candidateRows) {
      const previous = block.at(-1);
      const interveningOtherCandidate = previous && rows.some((between) => between.row > previous.row
        && between.row < row.row
        && identity.get(between.row)?.role === "candidate"
        && identity.get(between.row)?.name?.toLocaleLowerCase() !== candidate.toLocaleLowerCase());
      if (interveningOtherCandidate && block.length) {
        blocks.push(block);
        block = [];
      }
      block.push(row);
    }
    if (block.length) blocks.push(block);
    for (const blockRows of blocks) {
      const first = blockRows[0];
      const last = blockRows.at(-1);
      const handoff = (Array.isArray(handoffs) ? handoffs : [])
        .filter((item) => item.candidate?.toLocaleLowerCase() === candidate.toLocaleLowerCase()
          && item.row <= first.row)
        .at(-1);
      output.push({
        candidate,
        start_row: first.row,
        end_row: last.row,
        since: Number(first.since || 0),
        until: Number(last.until || 0),
        handoff_row: handoff?.row || null,
        summary: "",
        confidence: 0.98,
        source_text: blockRows.map((row) => row.text).join(" ").replace(/\s+/gu, " ").trim(),
      });
    }
  }
  return output;
}

function summaryMisattributesAnotherCandidate(summary, candidate, candidates = []) {
  const value = cleanName(summary);
  const current = cleanName(candidate).toLocaleLowerCase();
  const attribution = /\b(?:continues?|states?|says?|argues?|proposes?|explains?|describes?|believes?|notes?|highlights?|criticizes?|calls?|emphasizes?|outlines?|recommends?)\b/iu;
  return (Array.isArray(candidates) ? candidates : []).some((other) => {
    const name = cleanName(other);
    if (!name || name.toLocaleLowerCase() === current) return false;
    const escaped = name.split(/\s+/u).map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+");
    return new RegExp(`\\b${escaped}\\b(?:['’]s)?\\s+${attribution.source}`, "iu").test(value)
      || new RegExp(`^${escaped}\\b`, "iu").test(value);
  });
}

function validateSummary(answer, candidates = []) {
  const summary = String(answer.summary || "").trim();
  if (!summary || summary.length < 25) return false;
  if (/SPEAKER_\d+|the transcript says|according to the source/iu.test(summary)) return false;
  // A model must summarize the answer itself, never narrate that its bounded
  // source window was incomplete or describe who merely appeared in it.
  if (/(?:provided\s+)?(?:source|transcript)\s+text\s+(?:does\s+not|only\s+lists)|lists?\s+.+\s+as\s+a\s+participant|(?:transcript|source\s+window)\s+(?:ends?|contains?)\b|no\s+answer\s+(?:content|is\s+provided)|(?:only|merely)\s+(?:introduces?|identifies?|names?)\s+.+(?:for\s+a\s+follow[- ]?up|as\s+a\s+candidate)|only\s+includes?\s+(?:introductory|moderator)|streaming\s+availability|before\s+transitioning\s+to\s+the\s+next|begins?\s+to\s+(?:read|answer).{0,80}\bcut\s+off\b|(?:discusses?|confirms?)\s+(?:the\s+)?(?:order\s+of\s+questions?|the\s+next\s+topic)/iu.test(summary)) return false;
  if (summaryMisattributesAnotherCandidate(summary, answer.candidate, candidates)) return false;
  return true;
}

function readPriorCandidateAnswers(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return Array.isArray(parsed?.answers) ? parsed.answers : [];
  } catch {
    return [];
  }
}

function summaryTokenOverlap(left, right) {
  const tokens = (value) => new Set(String(value || "").toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 4));
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.max(1, Math.min(a.size, b.size));
}

function priorVerifiedSummary(answer, priorAnswers, candidates = []) {
  const candidate = cleanName(answer?.candidate).toLocaleLowerCase();
  const question = cleanName(answer?.question_id).toLocaleLowerCase();
  if (!candidate || !question) return "";
  const matches = (Array.isArray(priorAnswers) ? priorAnswers : [])
    .filter((prior) => cleanName(prior?.candidate).toLocaleLowerCase() === candidate
      && cleanName(prior?.question_id).toLocaleLowerCase() === question
      && String(prior?.summary || "").trim().length >= 25)
    .sort((a, b) => summaryTokenOverlap(b?.source_text, answer?.source_text)
      - summaryTokenOverlap(a?.source_text, answer?.source_text));
  const prior = matches[0];
  if (!prior || summaryTokenOverlap(prior.source_text, answer.source_text) < 0.55) return "";
  const summary = String(prior.summary || "").replace(/\s+/gu, " ").trim().slice(0, 900);
  return validateSummary({ candidate: answer.candidate, summary }, candidates) ? summary : "";
}

function writePya(filePath, answers) {
  const lines = ["su name candidate answer chapters artifact be series def"];
  for (const answer of answers) {
    const payload = JSON.stringify({
      id: answer.id,
      question_id: answer.question_id,
      question_title: answer.question_title,
      candidate: answer.candidate,
      start_row: answer.start_row,
      end_row: answer.end_row,
      since: answer.since,
      until: answer.until,
      summary: answer.summary,
      confidence: answer.confidence,
      handoff_row: answer.handoff_row,
    });
    lines.push(`su name candidate answer chapter ${answer.id} since num ${Number(answer.since).toFixed(3)} until num ${Number(answer.until).toFixed(3)} ob text "${pyaEsc(payload)}" ya`);
  }
  lines.push("prah");
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function main() {
  const transcriptDirArg = process.argv[2];
  const prefix = process.argv[3] || "meeting-qwen-auto-normalized";
  if (!transcriptDirArg) { usage(); process.exit(2); }
  const transcriptDir = path.resolve(process.cwd(), transcriptDirArg);
  const speakerJsonPath = path.join(transcriptDir, `${prefix}.sentences.speaker.sentences.json`);
  const mapPath = path.join(transcriptDir, `${prefix}.speaker-name-map.json`);
  const questionPath = path.join(transcriptDir, `${prefix}.question-boundaries.json`);
  if (![speakerJsonPath, mapPath, questionPath].every((filePath) => fs.existsSync(filePath))) {
    throw new Error("candidate-answer segmentation requires speaker JSON, speaker-name map, and question boundaries");
  }
  const rows = readRows(speakerJsonPath);
  const map = readSpeakerMap(mapPath);
  const identity = buildRowIdentity(rows, map);
  const candidates = canonicalCandidates(map);
  const normalizationMap = readNormalizationMap(transcriptDir, prefix);
  const canonicalLocation = inferCanonicalLocation(rows, normalizationMap);
  const handoffs = findHandoffs(rows, map, candidates);
  const boundaries = JSON.parse(fs.readFileSync(questionPath, "utf8"))?.boundaries || [];
  if (!rows.length || !candidates.length || !boundaries.length) throw new Error("candidate-answer segmentation has insufficient grounded inputs");
  // Boundary detection is LLM-assisted, but a proposed boundary that starts
  // on an evidence-backed candidate sentence is not a new moderator question.
  // Reject only that contradicted class here; moderator and audience rows are
  // left for the normal question-window adjudication.
  const verifiedBoundaries = boundaries.filter((boundary) => {
    const row = rows.find((item) => item.row === Number(boundary?.row));
    const person = row ? identity.get(row.row) : null;
    return !(person?.role === "candidate" && !isControlOrQuestion(row.text));
  });
  const authoritativeQuestions = officialQuestionWindows(transcriptDir, prefix, rows);
  const windows = [
    ...officialAnswerWindows(transcriptDir, prefix, rows, candidates),
    ...(authoritativeQuestions.length ? authoritativeQuestions : questionWindows(rows, verifiedBoundaries)),
  ].sort((a, b) => a.start_row - b.start_row);
  for (const window of windows) {
    window.handoffs = handoffs.filter((handoff) => handoff.row >= window.start_row && handoff.row <= window.end_row);
    window.reviewedBoundaries = (Array.isArray(map?.spans) ? map.spans : [])
      .filter((span) => /operator-reviewed identity correction|recording review confirms/iu.test(String(span?.reason || "")))
      .filter((span) => Number(span.start_row) >= window.start_row && Number(span.start_row) <= window.end_row)
      .map((span) => ({ start_row: Number(span.start_row), end_row: Number(span.end_row), canonical_name: cleanName(span.canonical_name) }));
  }
  const answers = [];
  const priorAnswersPath = path.join(transcriptDir, `${prefix}.candidate-answer-chapters.json`);
  const priorAnswers = readPriorCandidateAnswers(priorAnswersPath);
  const allowLlmIdentityFallback = !/^(?:0|false|no|off)$/iu.test(String(process.env.PYA_CANDIDATE_ANSWER_LLM_IDENTITY_FALLBACK || "1"));
  const forceAllQuestionCoverage = /^(?:1|true|yes|on)$/iu.test(String(process.env.PYA_CANDIDATE_ANSWER_REQUIRE_EACH || ""));
  for (const window of windows) {
    const strictCoverage = !/^(?:0|false|no|off)$/iu.test(String(process.env.PYA_CANDIDATE_ANSWER_REQUIRE_EACH || "1"));
    const completeRound = strictCoverage && /^question_/iu.test(window.question_id)
      && (window.coverage_required !== false || forceAllQuestionCoverage);
    const response = await askOllama({ prompt: answerPrompt(window, rows, identity, candidates, [], completeRound), maxTokens: completeRound ? 3000 : 1400 });
    const parsed = parseJsonObject(response);
    let rawAnswers = Array.isArray(parsed?.answers) ? parsed.answers : [];
    let clean = dedupeAnswers(rawAnswers.map((item) => sanitizeAnswer(item, window, rows, identity, candidates, allowLlmIdentityFallback)).filter(Boolean));
    if (completeRound) {
      // The model may omit a candidate or a later follow-up when several
      // answers share one noisy diarization key. Add every independently
      // verified candidate block; dedupeAnswers merges overlapping model and
      // evidence spans while preserving distinct blocks after another
      // candidate has spoken. Their summaries still go through the normal
      // non-empty LLM generation and validation gate below.
      for (const fallback of evidenceAnswerFallbacks(window, rows, identity, candidates, window.handoffs)) {
        clean.push(fallback);
      }
      clean = dedupeAnswers(clean);
    }
    if (completeRound) {
      const preliminary = buildCandidateAnswerCoverage({
        windows: [window],
        answers: clean.map((answer) => ({ ...answer, question_id: window.question_id })),
        candidates,
        requireComplete: true,
      });
      const missing = preliminary.questions[0]?.missing_candidates || [];
      let repairAttempt = 0;
      const maxRepairAttempts = Math.max(1, Number(process.env.PYA_CANDIDATE_ANSWER_REPAIR_ATTEMPTS || 3));
      while (missing.length && repairAttempt < maxRepairAttempts) {
        repairAttempt += 1;
        for (const target of [...missing]) {
          process.stdout.write(`[candidate-answers] ${window.question_id} coverage repair for: ${target}\n`);
          const repairResponse = await askOllama({
            prompt: answerPrompt(window, rows, identity, candidates, [target], true),
            maxTokens: 1800,
          });
          const repairParsed = parseJsonObject(repairResponse);
          const repairAnswers = Array.isArray(repairParsed?.answers) ? repairParsed.answers : [];
          rawAnswers = [...rawAnswers, ...repairAnswers];
          clean = dedupeAnswers(rawAnswers.map((item) => sanitizeAnswer(item, window, rows, identity, candidates, allowLlmIdentityFallback)).filter(Boolean));
        }
        const retryCoverage = buildCandidateAnswerCoverage({
          windows: [window],
          answers: clean.map((answer) => ({ ...answer, question_id: window.question_id })),
          candidates,
          requireComplete: true,
        });
        missing.splice(0, missing.length, ...(retryCoverage.questions[0]?.missing_candidates || []));
      }
    }
    clean = await splitAtReviewedBoundaries(clean, window, rows);
    for (const answer of clean) {
      answer.summary = normalizeCandidateSummary(answer.summary, normalizationMap, canonicalLocation);
      if (!validateSummary(answer, candidates)) {
        // When a new sentence-level diarization pass improves boundaries but
        // the GPU model temporarily returns an empty repair, reuse a prior
        // verified LLM summary only when it is for the same candidate/question
        // and its source text substantially overlaps the new evidence range.
        // This preserves the prose without inventing a deterministic summary.
        const priorSummary = priorVerifiedSummary({
          ...answer,
          question_id: window.question_id,
        }, priorAnswers, candidates);
        if (priorSummary) answer.summary = normalizeCandidateSummary(priorSummary, normalizationMap, canonicalLocation);
      }
      if (!validateSummary(answer, candidates)) {
        // A bulk answer pass can occasionally copy the preceding candidate's
        // name into the next candidate's prose when both answers share one
        // diarization key. Re-summarize only that bounded, already-verified
        // source range rather than accepting the misattribution or guessing
        // from answer order.
        const repairedSummary = await summarizeCandidateAnswer(answer.candidate, window.title, answer.source_text);
        if (repairedSummary) answer.summary = normalizeCandidateSummary(repairedSummary, normalizationMap, canonicalLocation);
      }
      if (!validateSummary(answer, candidates)) continue;
      answers.push({
        ...answer,
        id: `${window.question_id}_${answer.candidate.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_|_$/gu, "")}_${answer.start_row}`,
        question_id: window.question_id,
        question_title: window.title,
      });
    }
    process.stdout.write(`[candidate-answers] ${window.question_id} ${window.title}: ${clean.length} verified candidates\n`);
  }
  const sorted = answers.sort((a, b) => a.since - b.since || a.start_row - b.start_row);
  const requireComplete = !/^(?:0|false|no|off)$/iu.test(String(process.env.PYA_CANDIDATE_ANSWER_REQUIRE_EACH || "1"));
  const coverage = buildCandidateAnswerCoverage({
    windows,
    answers: sorted,
    candidates,
    requireComplete,
  });
  const coveragePath = path.join(transcriptDir, `${prefix}.candidate-answer-coverage.json`);
  fs.writeFileSync(coveragePath, `${JSON.stringify(coverage, null, 2)}\n`, "utf8");
  if (!sorted.length) throw new Error(`candidate-answer segmentation produced no verified answers; coverage report: ${coveragePath}`);
  if (!coverage.pass) {
    const examples = coverage.issues.slice(0, 12).map((issue) => `${issue.question_id}: ${issue.candidate || issue.id || "unknown"} (${issue.issue})`).join("; ");
    throw new Error(`candidate-answer coverage failed: ${coverage.complete_question_count}/${coverage.question_count} questions complete; ${examples}; coverage report: ${coveragePath}`);
  }
  const jsonPath = path.join(transcriptDir, `${prefix}.candidate-answer-chapters.json`);
  const pyaPath = path.join(transcriptDir, `${prefix}.candidate-answer-chapters.pya`);
  const mdPath = path.join(transcriptDir, `${prefix}.candidate-answer-chapters.md`);
  const txtPath = path.join(transcriptDir, `${prefix}.candidate-answer-chapters.txt`);
  const payload = {
    schema: "andrii-candidate-answer-chapters-v1",
    source_speaker_json: speakerJsonPath,
    source_speaker_map: mapPath,
    source_question_boundaries: questionPath,
    generated_at: new Date().toISOString(),
    coverage,
    answers: sorted,
  };
  fs.writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  writePya(pyaPath, sorted);
  const md = ["# Candidate answer chapters", "", ...sorted.map((answer) => [
    `## ${secondsToTimestamp(answer.since)} ${answer.candidate} — ${answer.question_title}`,
    "",
    answer.summary,
    "",
  ].join("\n"))].join("\n");
  fs.writeFileSync(mdPath, `${md}\n`, "utf8");
  fs.writeFileSync(txtPath, `${sorted.map((answer) => `${secondsToTimestamp(answer.since)} ${answer.candidate} — ${answer.question_title}`).join("\n")}\n`, "utf8");
  process.stdout.write(`[candidate-answers] answers: ${sorted.length}\n`);
  process.stdout.write(`[candidate-answers] wrote: ${jsonPath}\n`);
}

main().catch((error) => {
  process.stderr.write(`${String(error?.stack || error?.message || error)}\n`);
  process.exit(1);
});
