#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { requestManagedOllamaChat } from "../../../../program/runtime/gpu/managed-ollama.mjs";
import {
  findAuthoritativeChapterFile,
  parseAuthoritativeChapterText,
} from "./chapter-timestamps.mjs";

const NAME_MAP_VERSION = 1;
const MIN_CONFIDENCE = 0.82;
const DEFAULT_BATCH_ROWS = 90;

function usage() {
  process.stdout.write("Usage: node program/link-panel-speakers-from-transcript-folder.mjs <transcript_dir> [prefix]\n");
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function pyaEsc(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function parseJsonObject(text) {
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

function envNumber(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readRows(filePath) {
  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  return rows.map((row, index) => ({
    row: Number.isInteger(Number(row?.index)) ? Number(row.index) : index + 1,
    since: Number(row?.since || 0),
    until: Number(row?.until || 0),
    speaker_key: String(row?.speaker_key || row?.display || "speaker_unknown").trim() || "speaker_unknown",
    text: String(row?.text || "").replace(/\s+/gu, " ").trim(),
  })).filter((row) => row.text);
}

function rowLine(row) {
  return `ROW ${row.row} | ${row.since.toFixed(2)}-${row.until.toFixed(2)} | ${row.speaker_key} | ${row.text}`;
}

function likelyNameEvidence(rows, roster = []) {
  const patterns = [
    /\b(?:my name is|i(?:'m| am)|this is)\b/iu,
    /\b(?:next|first|second|third|fourth|fifth|sixth|last|opening|closing)\b.{0,60}\b(?:from|is|will be|up)\b/iu,
    /\b(?:mr|ms|mrs|councillor|councilor|candidate)\b/iu,
    /\b(?:start(?:ing)?|begin(?:ning)?)\s+with\b/iu,
  ];
  const selected = rows.filter((row) => patterns.some((pattern) => pattern.test(row.text))
    || looksLikeBareNameCallout(row.text, roster));
  // The opening roster and explicit introductions are the highest-value
  // evidence. Keep a bounded sample for the model, but retain row numbers so
  // downstream validation can point back to the transcript.
  return selected.slice(0, 180);
}

// A moderator may hand off with only a short name cue (for example,
// “Julie King.”) rather than “Next up, Julie King.”  Treating every short
// sentence as a handoff would be unsafe, so require a name-shaped cue whose
// surname matches exactly one configured roster person.  The LLM still
// adjudicates the ASR spelling; this helper only ensures the evidence reaches
// that adjudication stage and the later span repair.
function looksLikeBareNameCallout(text, roster = [], aliases = []) {
  const value = String(text || "").replace(/\s+/gu, " ").trim().replace(/[.!?,;:]+$/u, "");
  if (!value || value.length > 80 || /[?;]/u.test(value)) return false;
  // These are moderator control/closing phrases, not bare candidate
  // callouts. Without this guard “Keep Carol Merton” or “Thank you, Carol
  // Merton” can start a false candidate span during a break or handoff.
  if (/^(?:keep|thank(?:\s+you)?|thanks)\b/iu.test(value)) return false;
  if (!/^[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,3}$/u.test(value)) return false;
  const normalized = cleanName(value).toLocaleLowerCase();
  if ((Array.isArray(aliases) ? aliases : []).some((alias) => cleanName(alias?.observed).toLocaleLowerCase() === normalized)) return true;
  const tokens = value.split(/\s+/u);
  const people = (Array.isArray(roster) ? roster : [])
    .filter((person) => person?.role === "candidate" || person?.role === "moderator");
  const surnameMatches = people.filter((person) => {
    const nameTokens = cleanName(person?.canonical_name).split(/\s+/u).filter(Boolean);
    const surname = nameTokens.at(-1);
    const escapedSurname = surname.replace(/[.*+?^${}()|[\]\\]/gu, "\\\\$&");
    return surname && new RegExp(`\\b${escapedSurname}\\b`, "iu").test(value);
  });
  return surnameMatches.length === 1;
}

function speakerSamples(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (!grouped.has(row.speaker_key)) grouped.set(row.speaker_key, []);
    const bucket = grouped.get(row.speaker_key);
    if (bucket.length < 5) bucket.push(row);
  }
  return [...grouped.entries()].map(([key, sample]) => [
    `SPEAKER ${key}`,
    sample.map(rowLine).join("\n"),
  ].join("\n")).join("\n\n");
}

async function askJson({ system, prompt, schema, maxTokens = 1800 }) {
  const host = String(process.env.OLLAMA_HOST || "http://mriczo:11434").replace(/\/+$/u, "");
  let lastContent = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await requestManagedOllamaChat({
      ollamaUrl: host,
      managerUrl: process.env.PYA_GPU_HOUSEKEEPER_URL || "",
      keepAlive: 180,
      think: false,
      options: { num_predict: maxTokens, temperature: 0.05 },
      format: schema,
      messages: [
        { role: "system", content: system },
        { role: "user", content: `${prompt}\n\nReturn a complete JSON object now. Do not include analysis, markdown, or a partial response.` },
      ],
      timeoutMs: Number(process.env.ANDRII_OLLAMA_TIMEOUT_MS || 900000),
    });
    lastContent = String(result?.message?.content || result?.response || "").trim();
    const parsed = parseJsonObject(lastContent);
    if (parsed) return parsed;
  }
  throw new Error(`speaker-name linking model returned invalid JSON: ${lastContent.slice(0, 180)}`);
}

const ROSTER_SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          canonical_name: { type: "string" },
          role: { type: "string" },
          confidence: { type: "number" },
          evidence_rows: { type: "array", items: { type: "integer" } },
          reason: { type: "string" },
        },
        required: ["canonical_name", "role", "confidence", "evidence_rows", "reason"],
      },
    },
  },
  required: ["people"],
};

const SPAN_SCHEMA = {
  type: "object",
  properties: {
    spans: {
      type: "array",
      items: {
        type: "object",
        properties: {
          start_row: { type: "integer" },
          end_row: { type: "integer" },
          canonical_name: { type: "string" },
          role: { type: "string" },
          confidence: { type: "number" },
          evidence_rows: { type: "array", items: { type: "integer" } },
          reason: { type: "string" },
        },
        required: ["start_row", "end_row", "canonical_name", "role", "confidence", "evidence_rows", "reason"],
      },
    },
  },
  required: ["spans"],
};

const ALIAS_SCHEMA = {
  type: "object",
  properties: {
    aliases: {
      type: "array",
      items: {
        type: "object",
        properties: {
          observed: { type: "string" },
          canonical_name: { type: "string" },
          confidence: { type: "number" },
          evidence_rows: { type: "array", items: { type: "integer" } },
          reason: { type: "string" },
        },
        required: ["observed", "canonical_name", "confidence", "evidence_rows", "reason"],
      },
    },
  },
  required: ["aliases"],
};

function cleanName(value) {
  return String(value || "").replace(/\s+/gu, " ").replace(/^[-*\d.\s]+/u, "").trim().slice(0, 100);
}

function cleanRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (/moderator/u.test(role)) return "moderator";
  if (/candidate/u.test(role)) return "candidate";
  return "unknown";
}

// A candidate's name can occur inside somebody else's answer (for example,
// “Carol Merton's idea ...”).  That is topic/reference evidence, not speaker
// identity.  Keep this distinction explicit so the linker cannot turn a
// third-person reference into a candidate span.
function isThirdPersonCandidateReference(text, canonicalName) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  const name = cleanName(canonicalName);
  if (!value || !name) return false;
  const tokens = name.split(/\s+/u).filter((token) => token.length >= 3);
  if (!tokens.length || !tokens.every((token) => {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`\\b${escaped}\\b`, "iu").test(value);
  })) return false;
  if (/\b(?:my name is|i(?:'m| am)|this is|next up|first up|second will|third will|fourth will|fifth will|sixth will|go to|will be|from)\b/iu.test(value)) return false;
  return new RegExp(`${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+")}['’]s?`, "iu").test(value)
    || new RegExp(`\\b(?:idea|proposal|plan|position|approach|comments?|statement|view|views|record|recorded)\\s+(?:of|from|by)\\s+${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+")}`, "iu").test(value)
    || new RegExp(`\\b(?:agrees? with|disagrees? with|mentions?|references?|criticizes?|criticised|supports?)\\s+${tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("\\s+")}`, "iu").test(value);
}

// Moderators sometimes call on a candidate with a comma-separated name cue
// (“Ray, Bob, you go ahead”).  ASR may split or corrupt the surname, so keep
// the cue as a normalized name sequence and let the roster resolver apply its
// unique first-name/alias rules.
function goAheadNameCallout(text) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  const token = "[\\p{L}][\\p{L}.'-]*";
  const match = value.match(new RegExp(`^\\s*((?:${token}\\s*,\\s*){0,2}${token})\\s*,\\s*(?:you\\s+)?(?:go|are|were)\\s+ahead\\b`, "iu"))
    || value.match(new RegExp(`^\\s*(${token})\\s+(?:you\\s+)?(?:go|are|were)\\s+ahead\\b`, "iu"));
  const name = match?.[1] ? match[1].replace(/[,/:]/gu, " ").replace(/\\s+/gu, " ").trim() : "";
  return /^(?:and\\s+)?(?:next|now)$/iu.test(name) ? "" : name;
}

function hasStructuralHandoffCue(text) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  return Boolean(goAheadNameCallout(value))
    || /^(?:and\s+)?(?:next|first|second|third|fourth|fifth|sixth)\s+(?:up|will|to|answer|question)\b/iu.test(value)
    || /^(?:and\s+)?(?:next|now)\s*,?\s*(?:we\s+have|is|we're\s+going\s+to)\b/iu.test(value)
    || /^(?:and\s+)?(?:next|now)\s*,?\s+[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,3}[.!?]?$/u.test(value)
    || /^(?:and\s+)?(?:next|now)\s*,?\s+(?:go\s+ahead\s*,?\s*|please\s+)?[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,3}[.!?]?$/iu.test(value)
    || /\bnext\s*,?\s+[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,3}[.!?]?$/iu.test(value)
    || /\b(?:next|following)\s+(?:answer|candidate|speaker)\b/iu.test(value)
    || /\b(?:go|start)\s+(?:to|with)\b/iu.test(value)
    || /\b(?:start(?:ing)?|begin(?:ning)?)\s+(?:again\s+)?with\s+[\p{L}][\p{L}.'-]*/iu.test(value)
    || /^(?:and\s+)?[\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){0,3}\s*,\s*(?:how|what|why|would|could|can|do|in your opinion)\b/iu.test(value)
    || /\b(?:you (?:are|were) up|work our way)\b/iu.test(value)
    || /^(?:thank you|thanks)[,.]?\s*(?:(?:mr|ms|mrs|councillor|councilor)\.?\s+)?[\p{L}]/iu.test(value)
    || /\b(?:would anybody(?: else)?|keep\s+[\p{L}]|take\s+(?:our\s+)?(?:first\s+)?break|you are listening to|mics? are off|off the record|what(?:'s| is) the next question)\b/iu.test(value)
    || /\b(?:will be|we will go to|we're going to go to)\b/iu.test(value);
}

// Some moderators close one answer and name the next candidate in the same
// sentence (for example, “Thank you, Andres Vorgan, Carol Merton”). A lone
// “Thank you, Candidate” closes a turn and must not start another answer; two
// or more roster-backed names make the final name an evidence-backed handoff.
function candidateAfterMultiNameThankYou(text, roster = [], aliases = []) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  if (!/^(?:thank you|thanks)\b/iu.test(value)) return "";
  const variants = [];
  for (const person of (Array.isArray(roster) ? roster : []).filter((item) => item?.role === "candidate")) {
    const canonical = cleanName(person.canonical_name);
    if (canonical) variants.push({ observed: canonical, canonical });
  }
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const observed = cleanName(alias?.observed);
    const canonical = cleanName(alias?.canonical_name);
    if (observed && canonical) variants.push({ observed, canonical });
  }
  const matches = [];
  for (const variant of variants.sort((a, b) => b.observed.length - a.observed.length)) {
    const escaped = variant.observed.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const at = value.search(new RegExp(`\\b${escaped}\\b`, "iu"));
    if (at >= 0) matches.push({ canonical: variant.canonical, at });
  }
  const ordered = [...new Map(matches.sort((a, b) => a.at - b.at).map((match) => [match.canonical.toLocaleLowerCase(), match])).values()];
  return ordered.length >= 2 ? ordered.at(-1).canonical : "";
}

function configuredRosterNames() {
  const raw = String(process.env.PYA_SPEAKER_NAME_ROSTER || "").trim();
  if (!raw) return [];
  const nameCase = (value) => String(value || "").split(/\s+/u).map((token) => {
    if (!token) return token;
    return token.slice(0, 1).toLocaleUpperCase() + token.slice(1).toLocaleLowerCase();
  }).join(" ");
  return raw.split(/[;\n|]+/u).map((item) => String(item || "").trim()).filter(Boolean).map((item) => {
    const comma = item.match(/^([^,]+),\s*(.+)$/u);
    return cleanName(nameCase(comma ? `${comma[2]} ${comma[1]}` : item));
  }).filter(Boolean);
}

// A source may contain a reliable self-introduction whose ASR spelling is
// wrong.  An operator can provide the verified moderator spelling without
// changing the generic panel-linking logic for other meetings.
function configuredModeratorName() {
  return cleanName(process.env.PYA_SPEAKER_MODERATOR_NAME || "");
}

function canonicalizeModeratorRoster(roster) {
  const configured = configuredModeratorName();
  if (!configured) return Array.isArray(roster) ? roster : [];
  const seen = new Set();
  return (Array.isArray(roster) ? roster : []).map((person) => {
    if (person?.role !== "moderator") return person;
    return { ...person, canonical_name: configured };
  }).filter((person) => {
    const key = `${person?.role || ""}:${String(person?.canonical_name || "").toLocaleLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rowMap(rows) {
  return new Map(rows.map((row) => [row.row, row]));
}

function validateRoster(raw, rows) {
  const validRows = rowMap(rows);
  const out = [];
  const configured = configuredRosterNames();
  const seen = new Set();
  for (const person of Array.isArray(raw?.people) ? raw.people : []) {
    const role = cleanRole(person?.role);
    const configuredModerator = configuredModeratorName();
    const name = role === "moderator" && configuredModerator
      ? configuredModerator
      : cleanName(person?.canonical_name);
    const confidence = Number(person?.confidence);
    const evidenceRows = [...new Set((Array.isArray(person?.evidence_rows) ? person.evidence_rows : [])
      .map(Number).filter((n) => Number.isInteger(n) && validRows.has(n)))].slice(0, 8);
    if (!name || !["moderator", "candidate"].includes(role) || !Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || !evidenceRows.length) continue;
    if (configured.length && role === "candidate" && !configured.some((candidate) => candidate.toLocaleLowerCase() === name.toLocaleLowerCase())) continue;
    const key = `${role}:${name.toLocaleLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      canonical_name: name,
      role,
      confidence: Math.min(1, confidence),
      evidence_rows: evidenceRows,
      reason: String(person?.reason || "").trim().slice(0, 400),
    });
  }
  // A numbered roll call alone is not enough: ASR can turn a spoken name into
  // a plausible but unrelated name. Require an opening handoff or a direct
  // self-identification followed by the candidate's opening block. This keeps
  // mention-only names out of the authoritative roster.
  // When an operator supplies a canonical panel roster, the model may omit a
  // candidate whose ASR spelling is especially distorted. Recover that person
  // only when a name token appears in a name-bearing handoff/self-introduction
  // row; the row remains the evidence gate, so this never fabricates a speaker
  // who is absent from the transcript.
  if (configured.length) {
    const evidenceRows = likelyNameEvidence(rows);
    for (const canonical of configured) {
      if (out.some((person) => person.canonical_name.toLocaleLowerCase() === canonical.toLocaleLowerCase())) continue;
      const tokens = canonical.split(/\s+/u).filter((token) => token.length >= 3);
      const matches = evidenceRows.filter((row) => tokens.some((token) => {
        const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        return new RegExp(`\\b${escaped}\\b`, "iu").test(row.text);
      }) && /\b(?:opening|next|first|second|third|fourth|fifth|sixth|answer|name is|i(?:'m| am))\b/iu.test(row.text));
      if (matches.length) {
        out.push({
          canonical_name: canonical,
          role: "candidate",
          confidence: 0.84,
          evidence_rows: matches.slice(0, 4).map((row) => row.row),
          reason: "Operator-confirmed roster name matched a name-bearing handoff or self-introduction row.",
        });
      }
    }
  }
  if (!out.some((person) => person.role === "moderator")) {
    const moderatorEvidence = rows.find((row) => /\bmy\s+name\s+is\s+([A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*){0,4})\b/iu.test(row.text)
      && /\bmoderator\b/iu.test(rows.slice(Math.max(0, row.row - 1), row.row + 3).map((item) => item.text).join(" ")));
    const match = moderatorEvidence?.text.match(/\bmy\s+name\s+is\s+([A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*){0,4})\b/iu);
    if (moderatorEvidence && match?.[1]) {
      out.unshift({
        canonical_name: configuredModeratorName() || cleanName(match[1]),
        role: "moderator",
        confidence: 0.95,
        evidence_rows: [moderatorEvidence.row],
        reason: "Explicit self-introduction identifies the moderator.",
      });
    }
  }
  const openingCandidates = out.filter((person) => person.role === "candidate" && person.evidence_rows.some((rowNumber) => {
    const row = validRows.get(rowNumber);
    const text = String(row?.text || "");
    const nameTokens = person.canonical_name.split(/\s+/u).filter((token) => token.length >= 3);
    const namesMatch = nameTokens.length > 0 && nameTokens.every((token) => {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
      return new RegExp(`\\b${escaped}\\b`, "iu").test(text);
    });
    return rowNumber <= 240
      && namesMatch
      && /\b(?:opening statement|next up|first up|final opening|we will go to)\b/iu.test(text);
  }));
  if (configured.length) {
    const selected = configured.map((name) => openingCandidates.find((person) => person.canonical_name.toLocaleLowerCase() === name.toLocaleLowerCase())
      || out.find((person) => person.canonical_name.toLocaleLowerCase() === name.toLocaleLowerCase())).filter(Boolean);
    if (selected.length >= Math.min(3, configured.length)) {
      return canonicalizeModeratorRoster([...out.filter((person) => person.role === "moderator"), ...selected.map((person) => ({ ...person, canonical_name: configured.find((name) => name.toLocaleLowerCase() === person.canonical_name.toLocaleLowerCase()) || person.canonical_name }))]);
    }
  }
  if (openingCandidates.length >= 4) return canonicalizeModeratorRoster([...out.filter((person) => person.role === "moderator"), ...openingCandidates]);
  return canonicalizeModeratorRoster(out);
}

function candidateRosterPrompt(rows) {
  const evidence = likelyNameEvidence(rows).map(rowLine).join("\n");
  const configured = configuredRosterNames();
  return [
    "Extract the people who speak in this mayoral candidates forum.",
    "Return only people whose identity is supported by transcript evidence.",
    "A numbered roll call is only a candidate for evidence. Prefer names attached to an opening handoff followed by that person's contiguous opening remarks, or to a direct self-introduction. Do not add a second candidate merely because an isolated ASR name sounds different.",
    "Use the strongest transcript-supported spelling. Do not invent a surname, merge two people, or treat a person mentioned in passing as a speaker.",
    "Include the moderator only when the transcript explicitly gives the moderator's name. Include candidates only when they are actually on-stage speakers.",
    "For each person, cite row numbers that contain a self-introduction, the moderator's roll call, or a clear handoff to that person.",
    "If two spellings cannot be reconciled from the transcript, omit the uncertain person rather than guessing.",
    configured.length ? `OPERATOR-CONFIRMED CANONICAL CANDIDATE NAMES (use these exact spellings and do not add names): ${configured.join("; ")}` : "",
    configuredModeratorName() ? `OPERATOR-CONFIRMED MODERATOR NAME (use this exact spelling): ${configuredModeratorName()}` : "",
    "",
    "NAME-BEARING TRANSCRIPT EVIDENCE:",
    evidence.slice(0, 24000),
  ].join("\n");
}

function labelBatchPrompt(batch, roster) {
  const rosterText = roster.map((person) => `${person.canonical_name} (${person.role}) evidence rows ${person.evidence_rows.join(",")}`).join("\n");
  return [
    "Link transcript row ranges to the named people in the verified roster below.",
    "This is a structured candidate forum: the moderator calls each candidate by name immediately before that candidate speaks. Treat that explicit handoff as the primary identity evidence; the raw diarizer speaker key may be wrong or may change between sentences.",
    "Return only high-confidence ranges. The output is sentence-level: every sentence in a candidate's answer must be covered, and you may use one-row ranges. Split a diarizer segment whenever a handoff or explicit moderator question changes the speaker.",
    "A candidate range is valid when it is an answer or statement by that person, supported by direct self-identification, a moderator handoff, the answer order around an explicit question, or unmistakable continuity from the preceding sentence. Once a moderator hands off to a candidate, label each following answer sentence (including short acknowledgements such as 'Thanks very much') until the candidate's thanks/close or the next moderator handoff; do not leave a gap merely because the raw diarizer key changes.",
    "The moderator may introduce candidates and ask questions; do not label those rows as the candidate unless the candidate is actually speaking.",
    "Do not infer a name solely from the current speaker ID or from where a person sits. If the identity is mixed or uncertain, leave that row out.",
    "A sentence that says another candidate's name (for example, 'Carol Merton's idea of housing first') is a third-person reference, not a handoff and not evidence that Carol is speaking. Never use such a reference as the sole identity evidence for a span.",
    "Use exactly one canonical_name from the roster. Use role 'moderator' or 'candidate'. Confidence must be between 0 and 1.",
    "Never label a moderator question, a handoff ('next up', 'thank you', 'the question is'), or an instruction as a candidate's answer. If a diarizer segment mixes a handoff with an answer, omit the handoff rows and label only the clear answer rows.",
    "Each returned range must cite evidence_rows from this batch or the roster's evidence rows.",
    "",
    "VERIFIED ROSTER:",
    rosterText,
    "",
    "TRANSCRIPT ROWS:",
    batch.map(rowLine).join("\n"),
  ].join("\n");
}

function validateSpans(raw, rows, roster, batchStart, batchEnd) {
  const known = new Map(roster.map((person) => [person.canonical_name.toLocaleLowerCase(), person]));
  const validRows = rowMap(rows);
  const out = [];
  for (const span of Array.isArray(raw?.spans) ? raw.spans : []) {
    const start = Number(span?.start_row);
    const end = Number(span?.end_row);
    const name = cleanName(span?.canonical_name);
    const role = cleanRole(span?.role);
    const confidence = Number(span?.confidence);
    const person = known.get(name.toLocaleLowerCase());
    if (!person || !Number.isInteger(start) || !Number.isInteger(end) || start < batchStart || end > batchEnd || end < start) continue;
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || role !== person.role) continue;
    const evidenceRows = [...new Set((Array.isArray(span?.evidence_rows) ? span.evidence_rows : [])
      .map(Number).filter((n) => Number.isInteger(n) && validRows.has(n)))].slice(0, 8);
    if (!evidenceRows.length) continue;
    // A row that merely discusses another candidate is not identity evidence
    // for that candidate. Reject a span whose supplied evidence contains only
    // this kind of third-person reference; the later answer pass can then use
    // the actual handoff/continuity evidence or leave the identity uncertain.
    const referenceRows = evidenceRows.filter((rowNumber) => isThirdPersonCandidateReference(validRows.get(rowNumber)?.text, person.canonical_name));
    const startsAtReference = referenceRows.some((rowNumber) => Number(start) >= rowNumber && Number(start) <= rowNumber + 2);
    const directEvidence = evidenceRows.some((rowNumber) => {
      const text = validRows.get(rowNumber)?.text || "";
      return /\b(?:my name is|i(?:'m| am)|this is)\b/iu.test(text)
        || hasNamedHandoff(text, person.canonical_name);
    });
    if (referenceRows.length && startsAtReference && !directEvidence) continue;
    out.push({
      start_row: start,
      end_row: end,
      canonical_name: person.canonical_name,
      role: person.role,
      confidence: Math.min(1, confidence),
      evidence_rows: evidenceRows,
      reason: String(span?.reason || "").trim().slice(0, 400),
    });
  }
  return out;
}

function aliasPrompt(rows, roster, spans = [], aliases = []) {
  const rosterText = roster.map((person) => `${person.canonical_name} (${person.role})`).join("; ");
  const evidenceRows = likelyNameEvidence(rows, roster);
  const rowIndex = new Map(rows.map((row, index) => [row.row, index]));
  const context = new Map();
  for (const evidence of evidenceRows) {
    const index = rowIndex.get(evidence.row);
    if (!Number.isInteger(index)) continue;
    for (let cursor = Math.max(0, index - 4); cursor <= Math.min(rows.length - 1, index + 8); cursor += 1) {
      context.set(rows[cursor].row, rows[cursor]);
    }
  }
  const verified = (Array.isArray(spans) ? spans : [])
    .filter((span) => Number(span?.confidence || 0) >= 0.99 && span?.role === "candidate")
    .map((span) => `${span.canonical_name}: rows ${span.start_row}-${span.end_row}`)
    .join("; ");
  const namedHandoffs = rows.filter((row) => namedHandoffText(row.text, roster)).map(rowLine).join("\n");
  const knownAliasNames = new Set((Array.isArray(aliases) ? aliases : [])
    .map((alias) => cleanName(alias?.observed).toLocaleLowerCase())
    .filter(Boolean));
  const aliasResolvedHandoffs = rows
    .filter((row) => {
      const observed = namedHandoffText(row.text, roster);
      return observed && !knownAliasNames.has(observed.toLocaleLowerCase());
    })
    .map(rowLine)
    .join("\n");
  const unresolvedHandoffs = rows
    .filter((row) => namedHandoffText(row.text, roster) && !handoffCandidateFromText(row.text, roster, aliases))
    .map(rowLine)
    .join("\n");
  return [
    "Find ASR spellings in the transcript that refer to a person in the verified roster.",
    "Return only aliases for the moderator or mayoral candidates. Do not include organizations, places, artists, programmes, or unrelated people.",
    "An alias must be supported by a direct self-introduction, a moderator handoff, or an adjacent roll call followed by a contiguous answer block. Do not map one candidate to another merely because both names occur in the same window. If identity is uncertain, omit it.",
    "For a handoff alias, inspect the immediately following answer block and the candidate's confirmed opening/closing evidence. A phonetic ASR variant such as Joey Kim may be mapped to Jodi King only when that continuity is clear; otherwise omit it.",
    "Use the adjacent answer's biography and repeated self-description as identity evidence, not name similarity alone. If the answer repeats a verified candidate's distinctive work, organizations, or biography, map the ASR name to that candidate. Never map an alias to a different candidate just because the handoff order or a diarizer key happens to match.",
    "Review every named handoff below, including short name-only cues such as 'Julie King.'. When its spelling differs from the verified roster, return an alias if the following contiguous speech identifies the candidate; do not silently omit a supported handoff.",
    "A cue may already resolve through an existing first-name alias (for example, an ASR 'Andres' cue). Still return the complete observed spelling as a separate alias whenever that spelling differs from the roster and the adjacent answer identifies the same candidate.",
    unresolvedHandoffs ? `UNRESOLVED NAMED HANDOFFS — each must be adjudicated or explicitly marked uncertain:\n${unresolvedHandoffs}` : "",
    "The canonical_name must be copied exactly from the verified roster. The observed value is the spelling actually present in the transcript text.",
    "Do not return a canonical name as its own alias. Confidence must be at least 0.82 and evidence_rows must cite the supporting rows.",
    `VERIFIED ROSTER: ${rosterText}`,
    verified ? `HIGH-CONFIDENCE VERIFIED SPANS: ${verified}` : "",
    namedHandoffs ? `NAMED HANDOFFS REQUIRING REVIEW:\n${namedHandoffs}` : "",
    aliasResolvedHandoffs ? `HANDOFF SPELLINGS NOT YET IN THE ALIAS MAP — REVIEW THESE TOO:\n${aliasResolvedHandoffs}` : "",
    "NAME-BEARING EVIDENCE WITH ADJACENT CONTEXT:",
    [...context.values()].sort((a, b) => a.row - b.row).map(rowLine).join("\n").slice(0, 36000),
  ].join("\n\n");
}

function bareNameAliasPrompt(rows, roster, aliases = []) {
  const unresolved = rows.filter((row) => looksLikeBareNameCallout(row.text, roster)
    && !handoffCandidateFromText(row.text, roster, aliases));
  if (!unresolved.length) return "";
  const rowIndex = new Map(rows.map((row, index) => [row.row, index]));
  const context = new Map();
  for (const row of unresolved) {
    const index = rowIndex.get(row.row);
    if (!Number.isInteger(index)) continue;
    for (let cursor = Math.max(0, index - 4); cursor <= Math.min(rows.length - 1, index + 14); cursor += 1) {
      context.set(rows[cursor].row, rows[cursor]);
    }
  }
  return [
    "Adjudicate short, name-only moderator callouts that the broad alias pass did not resolve.",
    "Return JSON only: {\"aliases\":[{\"observed\":string,\"canonical_name\":string,\"confidence\":number,\"evidence_rows\":number[],\"reason\":string}]}.",
    "Use only canonical names from the roster. Map a callout only when the following contiguous answer and the panel's answer order make the identity clear; otherwise omit it.",
    "The callout spelling may be phonetic ASR (for example, Julie King for the roster candidate Jodi King). Preserve the observed spelling in observed and use the exact roster spelling in canonical_name.",
    `ROSTER: ${roster.map((person) => `${person.canonical_name} (${person.role})`).join("; ")}`,
    "UNRESOLVED CALLOUT CONTEXT:",
    [...context.values()].sort((a, b) => a.row - b.row).map(rowLine).join("\n"),
  ].join("\n\n");
}

function validateAliases(raw, rows, roster, spans = []) {
  const known = new Map(roster.map((person) => [person.canonical_name.toLocaleLowerCase(), person]));
  const validRows = rowMap(rows);
  const out = [];
  const seen = new Set();
  for (const alias of Array.isArray(raw?.aliases) ? raw.aliases : []) {
    const observed = cleanName(alias?.observed).replace(/\s+/gu, " ");
    const canonicalName = cleanName(alias?.canonical_name);
    const person = known.get(canonicalName.toLocaleLowerCase());
    const confidence = Number(alias?.confidence);
    const evidenceRows = [...new Set((Array.isArray(alias?.evidence_rows) ? alias.evidence_rows : [])
      .map(Number).filter((n) => Number.isInteger(n) && validRows.has(n)))].slice(0, 8);
    // Never let an erroneous cross-person alias rewrite an operator-confirmed
    // canonical name (for example, "Andrii Zvorygin" -> another candidate).
    if (!observed || !person || known.has(observed.toLocaleLowerCase()) || observed.toLocaleLowerCase() === person.canonical_name.toLocaleLowerCase()) continue;
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE || !evidenceRows.length) continue;
    const observedRows = rows.filter((row) => new RegExp(`\\b${observed.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(row.text)).map((row) => row.row);
    const canonicalRows = person.evidence_rows || [];
    const locallyCorroborated = observedRows.some((observedRow) => canonicalRows.some((canonicalRow) => Math.abs(observedRow - canonicalRow) <= 8))
      || evidenceRows.some((evidenceRow) => canonicalRows.includes(evidenceRow));
    // A direct self-introduction is identity evidence even when the same
    // answer is split across diarizer keys and the canonical candidate's
    // verified opening was several minutes earlier. In that case the LLM is
    // adjudicating the phonetic ASR spelling against the supplied roster;
    // require the observed spelling to occur in the self-introduction (or an
    // immediately adjacent named handoff), rather than relying on row order.
    const selfIdentifiedRows = observedRows.filter((observedRow) => {
      const row = validRows.get(observedRow);
      return row && /\b(?:my\s+name\s+is|i(?:'m| am)|this is)\b/iu.test(row.text);
    });
    const namedHandoffRows = observedRows.filter((observedRow) => {
      const row = validRows.get(observedRow);
      return row && (/\b(?:next up|first up|second will|third will|fourth will|fifth will|sixth will|you (?:are|were) up|go to|will be)\b/iu.test(row.text)
        || looksLikeBareNameCallout(row.text, roster));
    });
    const directIdentityEvidence = selfIdentifiedRows.length > 0 || namedHandoffRows.length > 0;
    const identityRows = selfIdentifiedRows.length ? selfIdentifiedRows : (namedHandoffRows.length ? namedHandoffRows : observedRows);
    const observedSpeakerKeys = new Set(identityRows.map((observedRow) => validRows.get(observedRow)?.speaker_key).filter(Boolean));
    const targetSpeakerKeys = new Set(spans
      .filter((span) => Number(span?.confidence || 0) >= 0.99
        && span?.role === person.role && String(span?.canonical_name || "").toLocaleLowerCase() === person.canonical_name.toLocaleLowerCase())
      .flatMap((span) => rows.filter((row) => row.row >= Number(span.start_row) && row.row <= Number(span.end_row)).map((row) => row.speaker_key)));
    const otherCandidateKeyMatch = spans.some((span) => span?.role === "candidate"
      && Number(span?.confidence || 0) >= 0.99
      && String(span?.canonical_name || "").toLocaleLowerCase() !== person.canonical_name.toLocaleLowerCase()
      && rows.some((row) => row.row >= Number(span.start_row) && row.row <= Number(span.end_row)
        && observedSpeakerKeys.has(row.speaker_key)));
    const targetKeyMatch = [...observedSpeakerKeys].some((key) => targetSpeakerKeys.has(key));
    // When a self-introduction shares diarizer-key continuity with one
    // verified candidate, do not let the model map it to a different
    // candidate merely because the ASR spelling is unusual.
    if (directIdentityEvidence && otherCandidateKeyMatch && !targetKeyMatch) continue;
    if (!locallyCorroborated && !directIdentityEvidence && confidence < 0.95) continue;
    const key = observed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      observed,
      canonical_name: person.canonical_name,
      confidence: Math.min(1, confidence),
      evidence_rows: evidenceRows,
      reason: String(alias?.reason || "").trim().slice(0, 400),
    });
  }
  // Direct self-identification inside an independently linked high-confidence
  // span is stronger evidence than a name's surface similarity. Capture ASR
  // variants such as “Ray Watson” when the same row is linked to Ray Botten.
  for (const row of rows) {
    const match = row.text.match(/\b(?:[Mm]y\s+name\s+is|I'm|I am)\s+([A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*){0,4})\b/u);
    if (!match?.[1]) continue;
    const observed = cleanName(match[1]).replace(/\s+/gu, " ");
    const span = spans.find((candidate) => row.row >= candidate.start_row && row.row <= candidate.end_row && candidate.confidence >= 0.9);
    if (!span || observed.toLocaleLowerCase() === span.canonical_name.toLocaleLowerCase()) continue;
    const canonical = known.get(span.canonical_name.toLocaleLowerCase());
    if (!canonical) continue;
    const key = observed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      observed,
      canonical_name: canonical.canonical_name,
      confidence: 0.95,
      evidence_rows: [row.row],
      reason: "Direct self-identification occurs inside a high-confidence linked speaker span.",
    });
  }
  return out;
}

function sanitizeAliasList(aliases, roster) {
  const canonical = new Set((Array.isArray(roster) ? roster : [])
    .map((person) => cleanName(person?.canonical_name).toLocaleLowerCase())
    .filter(Boolean));
  const valid = (Array.isArray(aliases) ? aliases : []).filter((alias) => {
    const observed = cleanName(alias?.observed).toLocaleLowerCase();
    const target = cleanName(alias?.canonical_name).toLocaleLowerCase();
    // Keep aliases as spoken name variants, not whole moderator control
    // phrases. Those phrases are already handled by the generic handoff
    // parser and can otherwise create misleading mappings (for example,
    // “I have Carol Merton” or “Keep Carol Merton”).
    if (/^(?:i\s+have|we\s+have|keep|thank\s+you|next(?:\s+is)?|now\s+is)\b/iu.test(observed)) return false;
    return observed && target && canonical.has(target) && !canonical.has(observed) && observed !== target;
  });
  // Do not allow the same ASR first name to be assigned to two different
  // panelists. Prefer the mapping with direct self-identification evidence;
  // otherwise retain the highest-confidence adjudication. This prevents a
  // noisy “Andres …” handoff from being split between Andrii and another
  // candidate when the transcript already anchors Andres to Andrii.
  const preferred = new Map();
  for (const alias of valid) {
    const first = cleanName(alias?.observed).split(/\s+/u)[0]?.toLocaleLowerCase();
    const target = cleanName(alias?.canonical_name).toLocaleLowerCase();
    if (!first || !target) continue;
    const reason = String(alias?.reason || "");
    const score = Number(alias?.confidence || 0) + (/self-identification|direct self|confirmed/iu.test(reason) ? 0.2 : 0);
    const prior = preferred.get(first);
    if (!prior || score > prior.score) preferred.set(first, { target, score });
  }
  return valid.filter((alias) => {
    const first = cleanName(alias?.observed).split(/\s+/u)[0]?.toLocaleLowerCase();
    const target = cleanName(alias?.canonical_name).toLocaleLowerCase();
    return !first || !preferred.get(first) || preferred.get(first).target === target;
  });
}

function mergeAliasLists(previous, fresh, roster) {
  const merged = new Map();
  for (const alias of [...(Array.isArray(previous) ? previous : []), ...(Array.isArray(fresh) ? fresh : [])]) {
    const key = cleanName(alias?.observed).toLocaleLowerCase();
    if (key) merged.set(key, alias);
  }
  return sanitizeAliasList([...merged.values()], roster);
}

function namedHandoffText(text, roster = []) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  if (isRosterAnnouncement(value)) return "";
  const goAhead = goAheadNameCallout(value);
  if (goAhead) return goAhead;
  const shortNext = value.match(/\b(?:next|now)(?:\s*,?\s+(?:we\s+have|is)\s+|\s*,\s*(?:go\s+ahead\s*,?\s*|please\s+)?)([\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,3})[.!?]?$/iu);
  if (shortNext?.[1]) return cleanName(shortNext[1]).replace(/[.,!?]+$/u, "");
  const startWith = value.match(/\b(?:start(?:ing)?|begin(?:ning)?)\s+(?:again\s+)?with\s+([\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){0,1})/iu);
  if (startWith?.[1]) return cleanName(startWith[1]).replace(/[.,!?]+$/u, "");
  const surnameOnly = value.match(/^([A-Z][\p{L}.'-]{2,}),\s+you (?:are|were) up\b/u);
  if (surnameOnly?.[1]) return cleanName(surnameOnly[1]);
  if (!/\b(?:next up|(?:next|now)\s*,?\s*(?:we\s+have|is)|first up|second will|third will|fourth will|fifth will|sixth will|you (?:are|were) up|go to|will be)\b/iu.test(value)) {
    return looksLikeBareNameCallout(value, roster) ? cleanName(value).replace(/[.,!?]+$/u, "") : "";
  }
  const match = value.match(/\b(?:is|from|to|be)\s+([A-Z][\p{L}.'-]*(?:\s+[A-Z][\p{L}.'-]*){1,4})/u);
  return cleanName(match?.[1] || "").replace(/[.,!?]+$/u, "");
}

function isRosterAnnouncement(text) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  return /\b(?:the order in which|first up would be|second will be|third will be|fourth will be|fifth will be|sixth will be|we will reverse that)\b/iu.test(value);
}

// If a named handoff has an ASR-corrupted surname but its first name matches
// exactly one configured candidate, retain that as a low-risk validation
// fallback. The LLM remains responsible for ambiguous or fully corrupted
// names; this only prevents a supported handoff from disappearing when a
// response omits an obvious one.
function inferUnambiguousFirstNameAliases(rows, roster, aliases = []) {
  const knownAliases = new Set((Array.isArray(aliases) ? aliases : [])
    .map((alias) => cleanName(alias?.observed).toLocaleLowerCase()));
  const candidates = (Array.isArray(roster) ? roster : []).filter((person) => person?.role === "candidate");
  const output = [];
  for (const row of rows) {
    const observed = namedHandoffText(row.text, roster);
    if (!observed || knownAliases.has(observed.toLocaleLowerCase())) continue;
    const [first] = observed.split(/\s+/u);
    const matches = candidates.filter((person) => String(person.canonical_name || "").split(/\s+/u)[0].toLocaleLowerCase() === first.toLocaleLowerCase());
    if (matches.length !== 1) continue;
    const canonical = cleanName(matches[0].canonical_name);
    if (observed.toLocaleLowerCase() === canonical.toLocaleLowerCase()) continue;
    output.push({
      observed,
      canonical_name: canonical,
      confidence: 0.9,
      evidence_rows: [row.row],
      reason: "The moderator's named handoff preserves a unique canonical first name; the surname is an ASR variant.",
    });
    knownAliases.add(observed.toLocaleLowerCase());
  }
  return output;
}

function inferAdjacentSurnameAliases(rows, roster, aliases = [], spans = []) {
  const knownAliases = new Set((Array.isArray(aliases) ? aliases : [])
    .map((alias) => cleanName(alias?.observed).toLocaleLowerCase()));
  const candidates = (Array.isArray(roster) ? roster : []).filter((person) => person?.role === "candidate");
  const aliasFirstNames = new Map();
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const observed = cleanName(alias?.observed);
    const canonical = cleanName(alias?.canonical_name);
    const first = observed.split(/\s+/u)[0]?.toLocaleLowerCase();
    if (!first || !canonical) continue;
    const prior = aliasFirstNames.get(first) || new Set();
    prior.add(canonical.toLocaleLowerCase());
    aliasFirstNames.set(first, prior);
  }
  const output = [];
  for (const row of rows) {
    const observed = namedHandoffText(row.text, roster);
    if (!observed || knownAliases.has(observed.toLocaleLowerCase())) continue;
    const nearby = rows.filter((candidate) => candidate.row >= row.row - 3 && candidate.row < row.row);
    const matches = candidates.filter((person) => {
      const canonical = cleanName(person.canonical_name);
      return nearby.some((candidate) => canonical.split(/\s+/u).every((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\\\$&")}\\b`, "iu").test(candidate.text)))
        || nearby.some((candidate) => (Array.isArray(aliases) ? aliases : []).some((alias) => String(alias?.canonical_name || "").toLocaleLowerCase() === canonical.toLocaleLowerCase()
          && new RegExp(`\\b${String(alias?.observed || "").replace(/[.*+?^${}()|[\[\]\\]/gu, "\\\\$&")}\\b`, "iu").test(candidate.text)));
    });
    const first = observed.split(/\s+/u)[0]?.toLocaleLowerCase();
    const aliasTargets = [...(aliasFirstNames.get(first) || new Set())]
      .map((name) => candidates.find((person) => cleanName(person.canonical_name).toLocaleLowerCase() === name))
      .filter(Boolean);
    const following = rows.filter((candidate) => candidate.row > row.row && candidate.row <= row.row + 10 && !isModeratorControlCue(candidate.text));
    const targetKeyMatches = aliasTargets.filter((person) => {
      const targetKeys = new Set((Array.isArray(spans) ? spans : [])
        .filter((span) => span?.role === "candidate"
          && Number(span?.confidence || 0) >= 0.98
          && String(span?.canonical_name || "").toLocaleLowerCase() === cleanName(person.canonical_name).toLocaleLowerCase())
        .flatMap((span) => rows.filter((candidate) => candidate.row >= Number(span.start_row) && candidate.row <= Number(span.end_row)).map((candidate) => candidate.speaker_key)));
      return following.some((candidate) => targetKeys.has(candidate.speaker_key));
    });
    // The three rows before a handoff commonly contain the previous
    // candidate's thank-you/name cue. If the observed first name already has
    // one unambiguous alias target and the following speech uses that
    // candidate's anchored diarizer key, prefer the following span over the
    // stale preceding-name match. This handles new surname hallucinations
    // without hard-coding a meeting-specific spelling.
    if (aliasTargets.length === 1 && targetKeyMatches.length === 1) {
      matches.splice(0, matches.length, targetKeyMatches[0]);
    } else if (matches.length !== 1 && targetKeyMatches.length === 1) {
      matches.push(targetKeyMatches[0]);
    }
    if (matches.length !== 1) continue;
    const canonical = cleanName(matches[0].canonical_name);
    output.push({
      observed,
      canonical_name: canonical,
      confidence: 0.92,
      evidence_rows: [row.row, ...nearby.slice(-2).map((candidate) => candidate.row)],
      reason: "A surname-only moderator callout immediately follows the candidate's full named handoff.",
    });
    knownAliases.add(observed.toLocaleLowerCase());
  }
  return output;
}

// If the model leaves a short name-only cue unresolved, retain it only when
// the cue's surname uniquely identifies one candidate and the same diarizer
// key is already anchored to that candidate in a verified span. This is a
// narrow evidence fallback for phonetic first-name errors such as Julie/Jodi;
// it never maps a bare name from surname similarity alone.
function inferBareNameAliases(rows, roster, aliases = [], spans = []) {
  const knownAliases = new Set((Array.isArray(aliases) ? aliases : [])
    .map((alias) => cleanName(alias?.observed).toLocaleLowerCase()));
  const candidates = (Array.isArray(roster) ? roster : []).filter((person) => person?.role === "candidate");
  const output = [];
  for (const row of rows) {
    const observed = namedHandoffText(row.text, roster);
    if (!observed || knownAliases.has(observed.toLocaleLowerCase()) || !looksLikeBareNameCallout(row.text, roster)) continue;
    const tokens = observed.split(/\s+/u);
    const surname = tokens.at(-1)?.toLocaleLowerCase() || "";
    const matches = candidates.filter((person) => cleanName(person?.canonical_name).split(/\s+/u).at(-1)?.toLocaleLowerCase() === surname);
    if (matches.length !== 1) continue;
    const person = matches[0];
    const canonical = cleanName(person.canonical_name);
    if (observed.toLocaleLowerCase() === canonical.toLocaleLowerCase()) continue;
    const targetKeys = new Set((Array.isArray(spans) ? spans : [])
      .filter((span) => span?.role === "candidate"
        && Number(span?.confidence || 0) >= 0.98
        && String(span?.canonical_name || "").toLocaleLowerCase() === canonical.toLocaleLowerCase())
      .flatMap((span) => rows
        .filter((candidate) => candidate.row >= Number(span.start_row) && candidate.row <= Number(span.end_row))
        .map((candidate) => candidate.speaker_key)));
    const following = rows.filter((candidate) => candidate.row > row.row && candidate.row <= row.row + 8 && !isModeratorControlCue(candidate.text));
    if (!following.length || (!targetKeys.has(row.speaker_key) && !following.some((candidate) => targetKeys.has(candidate.speaker_key)))) continue;
    output.push({
      observed,
      canonical_name: canonical,
      confidence: 0.92,
      evidence_rows: [row.row, following[0].row],
      reason: "A short moderator name cue is followed by contiguous speech on a diarizer key already anchored to the uniquely matching candidate.",
    });
    knownAliases.add(observed.toLocaleLowerCase());
  }
  return output;
}

// A previous map may contain a handoff span produced before a phonetic alias
// was adjudicated. Remove only those short spans directly following an
// unresolved named handoff so they cannot bias the next alias pass.
function removeStaleNamedHandoffSpans(spans, rows, roster, aliases = []) {
  const handoffs = rows.map((row) => ({
    row,
    candidate: handoffCandidateFromText(row.text, roster, aliases),
    observed: namedHandoffText(row.text, roster),
  })).filter((item) => item.candidate || item.observed);
  if (!handoffs.length) return Array.isArray(spans) ? spans : [];
  return (Array.isArray(spans) ? spans : []).filter((span) => !handoffs.some((handoff, index) => {
    const next = handoffs[index + 1]?.row?.row || Number.POSITIVE_INFINITY;
    const start = Number(span?.start_row);
    if (!Number.isInteger(start) || start <= handoff.row.row || start > handoff.row.row + 12 || start >= next) return false;
    return !handoff.candidate || String(span?.canonical_name || "").toLocaleLowerCase() !== handoff.candidate.toLocaleLowerCase();
  }));
}

function removeReferenceOnlySpans(spans, rows, roster) {
  const validRows = rowMap(rows);
  return (Array.isArray(spans) ? spans : []).filter((span) => {
    if (/operator-reviewed identity correction|recording review confirms/iu.test(String(span?.reason || ""))) return true;
    const person = (Array.isArray(roster) ? roster : []).find((candidate) => String(candidate?.canonical_name || "").toLocaleLowerCase() === String(span?.canonical_name || "").toLocaleLowerCase());
    if (!person) return true;
    const evidenceRows = [...new Set((Array.isArray(span?.evidence_rows) ? span.evidence_rows : []).map(Number))]
      .map((row) => validRows.get(row)).filter(Boolean);
    if (!evidenceRows.length) return true;
    const hasReference = evidenceRows.some((row) => isThirdPersonCandidateReference(row.text, person.canonical_name));
    if (!hasReference) return true;
    // Only discard a span when the reference is the immediate evidence for
    // its start. A legitimate span may contain a later discussion of another
    // candidate while still being grounded by an earlier handoff.
    const startsAtReference = evidenceRows.some((row) => isThirdPersonCandidateReference(row.text, person.canonical_name)
      && Number(span.start_row) >= row.row
      && Number(span.start_row) <= row.row + 2);
    if (!startsAtReference) return true;
    const hasDirect = evidenceRows.some((row) => /\b(?:my name is|i(?:'m| am)|this is)\b/iu.test(row.text)
      || hasNamedHandoff(row.text, person.canonical_name));
    return hasDirect;
  });
}

function loadIdentityFeedback(transcriptDir, prefix, rows, roster) {
  const filePath = path.join(transcriptDir, `${prefix}.speaker-identity-feedback.json`);
  if (!fs.existsSync(filePath)) return [];
  let payload;
  try { payload = JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return []; }
  const known = new Map((Array.isArray(roster) ? roster : []).map((person) => [String(person?.canonical_name || "").toLocaleLowerCase(), person]));
  const valid = rowMap(rows);
  return (Array.isArray(payload) ? payload : payload?.ranges || [])
    .map((item) => {
      const start = Number(item?.start_row);
      const end = Number(item?.end_row);
      const name = cleanName(item?.canonical_name);
      const person = known.get(name.toLocaleLowerCase());
      if (!person || !Number.isInteger(start) || !Number.isInteger(end) || end < start || !valid.has(start)) return null;
      return {
        start_row: start,
        end_row: Math.min(end, rows.at(-1)?.row || end),
        canonical_name: person.canonical_name,
        role: person.role,
        confidence: 1,
        evidence_rows: [...new Set([start, ...(Array.isArray(item?.evidence_rows) ? item.evidence_rows : [])
          .map(Number).filter((row) => valid.has(row))])].slice(0, 8),
        reason: String(item?.reason || "Operator-reviewed identity correction.").trim().slice(0, 400),
      };
    }).filter(Boolean);
}

function resolveOverlaps(spans) {
  const byRow = new Map();
  for (const span of spans) {
    for (let row = span.start_row; row <= span.end_row; row += 1) {
      const previous = byRow.get(row);
      if (!previous || span.confidence > previous.confidence) byRow.set(row, span);
    }
  }
  const rows = [...byRow.keys()].sort((a, b) => a - b);
  const compact = [];
  for (const row of rows) {
    const span = byRow.get(row);
    const previous = compact[compact.length - 1];
    if (previous && previous.end_row + 1 === row && previous.canonical_name === span.canonical_name && previous.role === span.role) {
      previous.end_row = row;
      previous.confidence = Math.min(previous.confidence, span.confidence);
      previous.evidence_rows = [...new Set([...previous.evidence_rows, ...span.evidence_rows])].slice(0, 8);
    } else {
      compact.push({ ...span, start_row: row, end_row: row, evidence_rows: [...span.evidence_rows] });
    }
  }
  return compact;
}

function isModeratorControlCue(text) {
  const value = String(text || "").trim();
  return Boolean(goAheadNameCallout(value))
    || /^(?:next up|opening statement|the question|question(?: is|:)|(?:so\s+)?(?:the\s+)?(?:first|next|following)\s+question|first up|second will|third will|fourth will|fifth will|sixth will|our next|we(?:'re| are) going\s+(?:to|next|on)\b|please|let(?:'s| us)|time-wise|before i|each candidate|we have\s+(?:between|the next|another|five|six|a question|questions|no|one more)|again,? candidates?|as some of (?:the )?questions|go ahead|okay,?\s+(?:go ahead|for|first|next)|first,?\s+(?:for|we|let))\b/iu.test(value)
    || /\b(?:the question is|for this next question|we(?:'re| are) going to start|when we do closing remarks|would anybody(?: else)?|take\s+(?:(?:a|our)\s+)?(?:first\s+)?break|you are listening to|mics? are off|off the record|what(?:'s| is) the next question|(?:we(?:'ll| will)\s+)?move\s+on\s+to\s+the\s+next\s+question|we have more time|(?:everybody|everyone|each candidate)\s+will\s+get|go ahead|(?:thirty|30)[- ]second opportunity|(?:that(?:'s| is)\s+)?everybody\s+(?:on|with)\s+(?:their\s+)?follow[- ]?ups?)\b/iu.test(value)
    || /\b(?:i(?:'ll| will)\s+read\s+(?:that|this)|while\s+you(?:'re| are)\s+looking|one\s+more\s+time(?:\s+here)?|you(?:'re| are)\s+(?:looking|going)\s+through\s+your\s+notes|may\s+not\s+have\s+it\s+in\s+front)\b/iu.test(value)
    || /^(?:so\s+)?we\s+have\s*:\s*.+\?\s*$/iu.test(value)
    // A question mark alone is not enough: candidates often ask rhetorical
    // questions in their own answers. Restrict question-cue matching to the
    // moderator's recognizable interrogative forms.
    || /^(?:do you|would you|what|why|how|in your opinion|could you|can you|is this|are you|will you|which|where)\b.*\?\s*$/iu.test(value)
    || /^(?:this|that)\s+(?:is|was|would|could)\b.*\?\s*$/iu.test(value);
}

function isNamedThankYouCue(text, roster = [], aliases = []) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  if (!/^(?:thank you|thanks)[,.]?\s+/iu.test(value)) return false;
  const remainder = value.replace(/^(?:thank you|thanks)[,.]?\s+/iu, "");
  const names = [
    ...(Array.isArray(roster) ? roster : []).map((person) => cleanName(person?.canonical_name)),
    ...(Array.isArray(aliases) ? aliases : []).flatMap((alias) => [cleanName(alias?.observed), cleanName(alias?.canonical_name)]),
  ].filter(Boolean);
  return names.some((name) => {
    const tokens = name.split(/\s+/u).filter((token) => token.length >= 3);
    return tokens.length && tokens.every((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu").test(remainder));
  }) || /^(?:everyone|all|very much)\b/iu.test(remainder);
}

// A named thank-you closes the answer that immediately precedes it. When the
// diarizer reuses one key across panelists, that closing name is stronger
// evidence for the preceding answer than the raw key or an overlong LLM span.
// Resolve the observed spelling through the same roster/alias handoff logic
// used for ordinary moderator callouts.
function candidateNamedInThankYou(text, roster = [], aliases = []) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  if (!isNamedThankYouCue(value, roster, aliases)) return "";
  const remainder = value.replace(/^(?:thank you|thanks)[,.]?\s+/iu, "");
  return handoffCandidateFromText(`Next up, ${remainder}`, roster, aliases);
}

function isKeepNamedCandidateCue(text, roster = []) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  if (!/^keep\s+/iu.test(value)) return false;
  const remainder = value.replace(/^keep\s+/iu, "");
  return (Array.isArray(roster) ? roster : [])
    .filter((person) => person?.role === "candidate")
    .some((person) => {
      const name = cleanName(person?.canonical_name);
      const tokens = name.split(/\s+/u).filter((token) => token.length >= 3);
      return tokens.length && tokens.every((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\\\$&")}\\b`, "iu").test(remainder));
    });
}

function hasNamedHandoff(text, canonicalName) {
  const value = String(text || "");
  const tokens = String(canonicalName || "").split(/\s+/u).filter((token) => token.length >= 3);
  if (!tokens.length || !tokens.every((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/gu, "\\\\$&")}\\b`, "iu").test(value))) return false;
  return /\b(?:next up|opening statement|first up|final opening|we will go to|go to|will be|from|start with|answer(?:ing)?|respond(?:ing)?)\b/iu.test(value);
}

// A moderator handoff is stronger evidence than a noisy speaker key. If the
// LLM left a short gap between the handoff and a later span for the same
// candidate, conservatively carry the identity across the intervening
// sentence cues. This is evidence-bounded and applies to any panel format;
// it does not infer names from position, order, or a hard-coded meeting.
function repairHandoffGaps(spans, rows) {
  const sorted = [...(Array.isArray(spans) ? spans : [])].sort((a, b) => a.start_row - b.start_row);
  const repaired = [...sorted];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const left = sorted[i];
    const right = sorted[i + 1];
    if (left.role !== "candidate" || right.role !== "candidate" || left.canonical_name !== right.canonical_name) continue;
    const gapStart = left.end_row + 1;
    const gapEnd = right.start_row - 1;
    if (gapEnd < gapStart || gapEnd - gapStart > 40) continue;
    const handoffRows = rows.filter((row) => row.row >= Math.max(1, left.end_row - 12) && row.row <= left.end_row && hasNamedHandoff(row.text, left.canonical_name));
    if (!handoffRows.length) continue;
    const fillRows = rows.filter((row) => row.row >= gapStart && row.row <= gapEnd && !isModeratorControlCue(row.text));
    if (!fillRows.length) continue;
    const first = fillRows[0].row;
    const last = fillRows.at(-1).row;
    repaired.push({
      start_row: first,
      end_row: last,
      canonical_name: left.canonical_name,
      role: "candidate",
      confidence: Math.min(Number(left.confidence || 0.82), Number(right.confidence || 0.82), 0.95),
      evidence_rows: [...new Set([...(left.evidence_rows || []), ...(right.evidence_rows || []), ...handoffRows.slice(0, 2).map((row) => row.row)])].slice(0, 8),
      reason: "Explicit moderator handoff names this candidate; the intervening sentence cues lead directly into the same candidate's verified span.",
    });
  }
  return resolveOverlaps(repaired);
}

function authoritativeCandidateSpans(transcriptDir, prefix, rows, roster) {
  const chapterPath = findAuthoritativeChapterFile(transcriptDir, prefix);
  if (!chapterPath) return [];
  let chapters;
  try { chapters = parseAuthoritativeChapterText(fs.readFileSync(chapterPath, "utf8")); } catch { return []; }
  const candidateNames = roster
    .filter((person) => person.role === "candidate")
    .map((person) => String(person.canonical_name || "").trim())
    .filter(Boolean);
  const nearest = (seconds, minimum) => {
    let best = Math.max(0, Number(minimum) || 0);
    let distance = Number.POSITIVE_INFINITY;
    for (let i = best; i < rows.length; i += 1) {
      const d = Math.abs(Number(rows[i].since || 0) - Number(seconds || 0));
      if (d < distance) { best = i; distance = d; }
      if (Number(rows[i].since || 0) > Number(seconds || 0) && d > distance) break;
    }
    return best;
  };
  const starts = [];
  let minimum = 0;
  for (const chapter of chapters) {
    const index = nearest(chapter.since, minimum);
    starts.push(index);
    minimum = Math.min(rows.length - 1, index + 1);
  }
  const isControl = (text) => /^(?:next up|and\s+next|opening statement|the question|question(?: is|:)|first up|second will|third will|fourth will|fifth will|sixth will|our next|we(?:'re| are) going|please|let(?:'s| us)|time-wise|before i|each candidate|we have|thank you(?:[,.]|$)|is\s+[^.?!]{1,50}\?)/iu.test(String(text || "").trim())
    || /\b(?:the question is|for this next question|we(?:'re| are) going to start|when we do closing remarks|will be from)\b/iu.test(String(text || ""));
  const adjustedEntries = [];
  const adjustedStarts = [...starts];
  for (let i = 0; i < chapters.length; i += 1) {
    const match = String(chapters[i].title || "").match(/^(?:opening|closing):\s*(.+)$/iu);
    if (!match) continue;
    const observed = match[1].replace(/\s+/gu, " ").trim();
    const canonical = candidateNames.find((name) => name.toLocaleLowerCase() === observed.toLocaleLowerCase());
    if (!canonical) continue;
    let startIndex = starts[i];
    // Official markers can fall a few seconds before the first cue of the
    // newly introduced candidate. If the nearest cue is still the prior
    // speaker (or is only the moderator's handoff), advance to the first
    // non-control cue with a changed diarization key. This is an evidence-
    // bounded boundary refinement, not a positional candidate assumption.
    const priorKey = rows[Math.max(0, startIndex - 1)]?.speaker_key;
    const closing = /^closing:/iu.test(chapters[i].title);
    if (isControl(rows[startIndex]?.text)) {
      let cursor = startIndex;
      while (cursor < rows.length && isControl(rows[cursor]?.text)) cursor += 1;
      if (closing && priorKey && rows[cursor]?.speaker_key === priorKey
        && String(rows[cursor]?.text || "").trim().length < 80) {
        while (cursor < rows.length && rows[cursor]?.speaker_key === priorKey) cursor += 1;
      }
      if (cursor < rows.length) startIndex = cursor;
    } else if (closing && rows[startIndex]?.speaker_key === priorKey) {
      for (let cursor = startIndex; cursor < rows.length; cursor += 1) {
        if (rows[cursor]?.speaker_key !== priorKey) {
          startIndex = cursor;
          break;
        }
      }
    }
    adjustedStarts[i] = startIndex;
    adjustedEntries.push({ index: i, startIndex, canonical });
  }
  const out = [];
  for (let entryIndex = 0; entryIndex < adjustedEntries.length; entryIndex += 1) {
    const entry = adjustedEntries[entryIndex];
    const start = entry.startIndex + 1;
    const nextStart = adjustedStarts[entry.index + 1];
    const end = nextStart == null ? rows.length : Math.max(start, nextStart - 1);
    out.push({
      start_row: start,
      end_row: end,
      canonical_name: entry.canonical,
      role: "candidate",
      confidence: 1.0,
      evidence_rows: [start],
      reason: "Authoritative recording chapter explicitly identifies the candidate opening or closing segment.",
    });
  }
  return out;
}

function handoffCandidateFromText(text, roster, aliases = []) {
  const value = String(text || "").replace(/\s+/gu, " ").trim();
  if (isRosterAnnouncement(value)) return "";
  const multiThankYouCandidate = candidateAfterMultiNameThankYou(value, roster, aliases);
  if (multiThankYouCandidate) return multiThankYouCandidate;
  if (/^(?:keep|thank(?:\s+you)?|thanks)\b/iu.test(value)
      && !/\b(?:next|now|first|second|third|fourth|fifth|sixth)\b/iu.test(value)) return "";
  const hasHandoffCue = hasStructuralHandoffCue(value);
  if (!hasHandoffCue && !looksLikeBareNameCallout(value, roster, aliases)) return "";
  const goAhead = goAheadNameCallout(value);
  const inlineNext = value.match(/\b(?:next|now)(?:\s*,?\s+(?:we\s+have|is)\s+|\s*,\s*(?:go\s+ahead\s*,?\s*|please\s+)?)([\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){1,3})[.!?]?$/iu);
  const handoffValue = goAhead || (inlineNext?.[1] ? cleanName(inlineNext[1]) : value);
  const candidates = (Array.isArray(roster) ? roster : []).filter((person) => person?.role === "candidate");
  const variants = [];
  const aliasFirstNames = new Map();
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const observed = cleanName(alias?.observed);
    const canonical = cleanName(alias?.canonical_name);
    const first = observed.split(/\s+/u)[0]?.toLocaleLowerCase();
    if (!first || !canonical) continue;
    const prior = aliasFirstNames.get(first) || new Set();
    prior.add(canonical);
    aliasFirstNames.set(first, prior);
  }
  for (const person of candidates) {
    const canonical = cleanName(person.canonical_name);
    if (canonical) variants.push({ observed: canonical, canonical });
    const firstName = canonical.split(/\s+/u)[0];
    const firstNameCount = candidates.filter((candidate) => cleanName(candidate.canonical_name).split(/\s+/u)[0]?.toLocaleLowerCase() === firstName?.toLocaleLowerCase()).length;
    if (firstName && firstName.length >= 3 && firstNameCount === 1) {
      variants.push({ observed: firstName, canonical });
    }
  }
  for (const alias of Array.isArray(aliases) ? aliases : []) {
    const observed = cleanName(alias?.observed);
    const canonical = cleanName(alias?.canonical_name);
    if (observed && canonical) variants.push({ observed, canonical });
  }
  for (const [first, targets] of aliasFirstNames.entries()) {
    if (targets.size === 1) variants.push({ observed: first, canonical: [...targets][0] });
  }
  for (const variant of variants.sort((a, b) => b.observed.length - a.observed.length)) {
    const tokens = variant.observed.split(/\s+/u).filter((token) => token.length >= 3);
    if (tokens.length && tokens.every((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\[\]\\]/gu, "\\\\$&")}\\b`, "iu").test(handoffValue))) {
      return variant.canonical;
    }
  }
  return "";
}

// A named moderator handoff outranks a raw diarization key. This repairs the
// common case where the moderator and the first candidate share one diarized
// speaker key, so the LLM otherwise assigns the answer to the wrong person.
function applyNamedHandoffOverrides(spans, rows, roster, aliases = []) {
  const handoffs = rows.map((row) => ({ row, candidate: handoffCandidateFromText(row.text, roster, aliases) }))
    .filter((item) => item.candidate);
  if (!handoffs.length) return Array.isArray(spans) ? spans : [];
  const overrides = [];
  for (let i = 0; i < handoffs.length; i += 1) {
    const handoff = handoffs[i];
    const nextHandoffRow = handoffs[i + 1]?.row?.row || Number.POSITIVE_INFINITY;
    const target = String(handoff.candidate || "").toLocaleLowerCase();
    const answerWindowRows = rows.filter((row) => row.row > handoff.row.row
      && row.row < nextHandoffRow
      && row.row <= handoff.row.row + 80);
    const candidateSpan = (Array.isArray(spans) ? spans : [])
      .filter((span) => span?.role === "candidate"
        && Number(span.start_row) > handoff.row.row
        && Number(span.start_row) <= handoff.row.row + 12
        && Number(span.start_row) < nextHandoffRow)
      .sort((a, b) => Number(a.start_row) - Number(b.start_row))[0];
    let sourceSpan = candidateSpan;
    // The explicit handoff establishes the candidate. Keep every subsequent
    // non-control cue in the bounded window, even when the candidate's first
    // sentence shares the moderator's raw diarization key or precedes a
    // moderator follow-up question.
    const block = answerWindowRows.filter((row) => !isModeratorControlCue(row.text)
      && !isNamedThankYouCue(row.text, roster, aliases)
      && !isKeepNamedCandidateCue(row.text, roster));
    if (block.length && (!sourceSpan
      || Number(sourceSpan.end_row) < block.at(-1).row
      || Number(sourceSpan.start_row) > block[0].row)) {
      // Existing spans can contain only the first cue after a handoff when
      // the same raw key later changes. Extend them to the bounded, named
      // handoff-to-handoff answer block; moderator/question rows are trimmed
      // again by applyModeratorHandoffOverrides below.
      sourceSpan = {
        ...(sourceSpan || {}),
        start_row: block[0].row,
        end_row: block.at(-1).row,
        role: "candidate",
        confidence: Math.max(Number(sourceSpan?.confidence || 0), 0.96),
        evidence_rows: [...new Set([...(sourceSpan?.evidence_rows || []), handoff.row.row, block[0].row])],
      };
    }
    if (!sourceSpan) {
      // If the diarizer/LLM left the answer unlabeled, create a bounded span
      // when the explicit handoff is followed by substantive speech. A direct
      // self-introduction is strongest, but a non-control contiguous answer is
      // also valid because the moderator has already named the candidate.
      const selfIntro = block.find((row) => /\b(?:my\s+name\s+is|i(?:'m| am)|this is)\b/iu.test(row.text));
      if (!block.length || (isModeratorControlCue(block[0].text) && !selfIntro)) continue;
      sourceSpan = {
        start_row: block[0].row,
        end_row: block.at(-1).row,
        role: "candidate",
        confidence: 0.96,
        evidence_rows: [handoff.row.row, ...(selfIntro ? [selfIntro.row] : [block[0].row])],
      };
    }
    // Keep the complete bounded answer window here. A moderator may ask a
    // clarifying question between the candidate's opening sentence and the
    // remainder of the same answer, especially when both voices share a raw
    // diarization key. applyModeratorHandoffOverrides splits recognized
    // control rows back out while preserving the candidate on both sides.
    const endRow = Math.min(Number(sourceSpan.end_row), nextHandoffRow - 1);
    if (!Number.isInteger(endRow) || endRow < Number(sourceSpan.start_row)) continue;
    overrides.push({
      ...sourceSpan,
      end_row: endRow,
      canonical_name: handoff.candidate,
      confidence: Math.max(0.98, Number(sourceSpan.confidence || 0)),
      evidence_rows: [...new Set([...(sourceSpan.evidence_rows || []), handoff.row.row])].slice(0, 8),
      reason: "An explicit moderator name callout identifies the candidate immediately before this answer; the diarization key is not used as identity evidence.",
    });
  }
  const retained = [];
  for (const original of (Array.isArray(spans) ? spans : [])) {
    let fragments = [original];
    for (let index = 0; index < handoffs.length; index += 1) {
      const handoff = handoffs[index];
      if (!handoff.candidate) continue;
      const nextHandoffRow = handoffs[index + 1]?.row?.row || Number.POSITIVE_INFINITY;
      const splitStart = handoff.row.row + 1;
      const target = handoff.candidate.toLocaleLowerCase();
      fragments = fragments.flatMap((span) => {
        const start = Number(span?.start_row);
        const end = Number(span?.end_row);
        if (!Number.isInteger(start) || !Number.isInteger(end)
          || end < splitStart || start >= nextHandoffRow) return [span];
        if (start >= splitStart && start < nextHandoffRow) return [];
        if (start < splitStart && end >= splitStart) return [{ ...span, end_row: handoff.row.row - 1 }];
        return [span];
      });
    }
    retained.push(...fragments);
  }
  return applyTrailingThankYouOverrides(resolveOverlaps([...retained, ...overrides]), rows, roster, aliases);
}

function applyTrailingThankYouOverrides(spans, rows, roster, aliases = []) {
  const closures = rows.map((row) => ({
    row,
    candidate: candidateNamedInThankYou(row.text, roster, aliases),
  })).filter((item) => item.candidate);
  if (!closures.length) return Array.isArray(spans) ? spans : [];
  const overrides = [];
  const byRow = new Map(rows.map((row) => [row.row, row]));
  const spanForRow = (rowNumber) => (Array.isArray(spans) ? spans : [])
    .filter((span) => span?.role === "candidate"
      && Number(span.start_row) <= rowNumber && Number(span.end_row) >= rowNumber)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0))[0];
  for (const closure of closures) {
    const target = closure.candidate;
    const targetRows = [];
    for (let rowNumber = Number(closure.row.row) - 1; rowNumber >= 1; rowNumber -= 1) {
      const row = byRow.get(rowNumber);
      if (!row || isModeratorControlCue(row.text)
        || isNamedThankYouCue(row.text, roster, aliases)
        || isKeepNamedCandidateCue(row.text, roster)) break;
      const priorSpan = spanForRow(rowNumber);
      if (!priorSpan) break;
      targetRows.unshift(rowNumber);
    }
    if (!targetRows.length) continue;
    overrides.push({
      start_row: targetRows[0],
      end_row: targetRows.at(-1),
      canonical_name: target,
      role: "candidate",
      confidence: 1,
      evidence_rows: [closure.row.row, targetRows[0]].slice(0, 8),
      reason: "A named moderator thank-you closes the immediately preceding candidate answer; the preceding raw diarization key is not used as identity evidence.",
    });
  }
  const retained = (Array.isArray(spans) ? spans : []).flatMap((span) => {
    let fragments = [{ ...span }];
    for (const override of overrides) {
      fragments = fragments.flatMap((fragment) => {
        const start = Number(fragment.start_row);
        const end = Number(fragment.end_row);
        if (!Number.isInteger(start) || !Number.isInteger(end)
          || end < override.start_row || start > override.end_row) return [fragment];
        const out = [];
        if (start < override.start_row) out.push({ ...fragment, end_row: override.start_row - 1 });
        if (end > override.end_row) out.push({ ...fragment, start_row: override.end_row + 1 });
        return out;
      });
    }
    return fragments;
  });
  return resolveOverlaps([...retained, ...overrides]);
}

// A named handoff or control run is spoken by the moderator even when the
// diarizer keeps the same acoustic key as the preceding candidate. Mark the
// cue (and any contiguous same-key break/announcement rows) as moderator,
// while leaving the following answer to the candidate span; this prevents
// lines such as “Next, go ahead, Carol Merton” from being attributed to the
// candidate whose answer just ended.
function applyModeratorHandoffOverrides(spans, rows, roster, aliases = []) {
  const moderator = (Array.isArray(roster) ? roster : []).find((person) => person?.role === "moderator");
  if (!moderator) return Array.isArray(spans) ? spans : [];
  const cues = rows.filter((row) => handoffCandidateFromText(row.text, roster, aliases)
    || isModeratorControlCue(row.text)
    || isNamedThankYouCue(row.text, roster, aliases)
    || isKeepNamedCandidateCue(row.text, roster));
  if (!cues.length) return Array.isArray(spans) ? spans : [];
  // Once an explicit moderator control cue is heard, only contiguous rows on
  // the same raw diarization key that are themselves control/question cues
  // remain moderator speech. Stop at the first ordinary greeting or answer:
  // a moderator and a candidate can share one raw key, especially in short
  // panel recordings. This covers break/recording announcements without
  // swallowing the candidate's response after a named handoff.
  const rowIndex = new Map(rows.map((row, index) => [Number(row.row), index]));
  const cueRuns = [];
  for (const cue of cues) {
    const startIndex = rowIndex.get(Number(cue.row));
    if (!Number.isInteger(startIndex)) continue;
    const key = String(cue.speaker_key || "").trim();
    let endIndex = startIndex;
    while (endIndex + 1 < rows.length && String(rows[endIndex + 1]?.speaker_key || "").trim() === key) {
      const nextText = String(rows[endIndex + 1]?.text || "").trim();
      if (!isModeratorControlCue(nextText)
        && !isNamedThankYouCue(nextText, roster, aliases)
        && !isKeepNamedCandidateCue(nextText, roster)) break;
      endIndex += 1;
    }
    cueRuns.push({ start: Number(cue.row), end: Number(rows[endIndex].row) });
  }
  const cueRows = new Set(cueRuns.flatMap((run) => {
    const out = [];
    for (let row = run.start; row <= run.end; row += 1) out.push(row);
    return out;
  }));
  const retained = [];
  for (const span of Array.isArray(spans) ? spans : []) {
    if (span?.role === "moderator") {
      const moderatorCueFragments = cueRuns
        .map((run) => ({
          ...span,
          start_row: Math.max(Number(span.start_row), run.start),
          end_row: Math.min(Number(span.end_row), run.end),
        }))
        .filter((fragment) => fragment.end_row >= fragment.start_row);
      // Existing maps may contain a moderator span that was extended across
      // the first candidate sentence by an older diarization rule. Where a
      // current cue run overlaps it, retain only the evidence-backed cue
      // rows; leave unrelated moderator introductions untouched.
      if (moderatorCueFragments.length) {
        retained.push(...moderatorCueFragments);
        continue;
      }
    }
    let fragments = [{ ...span }];
    for (const cueRow of cueRows) {
      fragments = fragments.flatMap((fragment) => {
        const start = Number(fragment.start_row);
        const end = Number(fragment.end_row);
        if (!Number.isInteger(start) || !Number.isInteger(end) || cueRow < start || cueRow > end) return [fragment];
        const out = [];
        if (start < cueRow) out.push({ ...fragment, end_row: cueRow - 1 });
        if (cueRow < end) out.push({ ...fragment, start_row: cueRow + 1 });
        return out;
      });
    }
    retained.push(...fragments.filter((fragment) => Number(fragment.end_row) >= Number(fragment.start_row)));
  }
  const overrides = cueRuns.map((run) => ({
    start_row: run.start,
    end_row: run.end,
    canonical_name: moderator.canonical_name,
    role: "moderator",
    confidence: 0.99,
    evidence_rows: [run.start, run.end].filter((row, index, values) => values.indexOf(row) === index),
    reason: "The row is an explicit moderator handoff or named turn-close cue; candidate identity begins after it.",
  }));
  return resolveOverlaps([...retained, ...overrides]);
}

function mergeAuthoritativeSpans(existingSpans, authoritativeSpans) {
  const overrides = Array.isArray(authoritativeSpans) ? authoritativeSpans : [];
  // A noisy model span that crosses an authoritative handoff is not safe to
  // trim: its middle may contain several speakers and resolveOverlaps would
  // otherwise stitch the fragments back into one false long-range identity.
  // Drop the crossing span and let the explicit chapter ranges replace it.
  const retained = (Array.isArray(existingSpans) ? existingSpans : [])
    .filter((span) => !overrides.some((override) => span.start_row <= override.end_row && span.end_row >= override.start_row));
  return resolveOverlaps([...retained, ...overrides]);
}

function writePyaMarker(markerPath, payload) {
  fs.writeFileSync(markerPath, [
    "su name speaker name map be map def",
    `su name schema version be num ${NAME_MAP_VERSION} ya`,
    `su name source sha256 be text \"${pyaEsc(payload.source_sha256)}\" ya`,
    `su name rows be num ${payload.rows} ya`,
    `su name roster count be num ${payload.roster.length} ya`,
    `su name verified spans be num ${payload.spans.length} ya`,
    `su name pass be bool ${payload.spans.length > 0 && payload.roster.length > 0 ? "true" : "false"} ya`,
    "prah",
    "",
  ].join("\n"), "utf8");
}

async function main() {
  const transcriptDir = path.resolve(process.cwd(), process.argv[2] || "");
  const prefix = process.argv[3] || "meeting-qwen-auto-normalized";
  if (!process.argv[2]) { usage(); process.exit(2); }
  const speakerJsonPath = path.join(transcriptDir, `${prefix}.sentences.speaker.sentences.json`);
  if (!fs.existsSync(speakerJsonPath)) throw new Error(`speaker transcript not found: ${speakerJsonPath}`);
  const rows = readRows(speakerJsonPath);
  if (!rows.length) throw new Error("speaker transcript has no rows");
  const sourceSha = sha256(fs.readFileSync(speakerJsonPath, "utf8"));
  const mapPath = path.join(transcriptDir, `${prefix}.speaker-name-map.json`);
  const markerPath = path.join(transcriptDir, `${prefix}.speaker-name-map.pya`);
  const existing = (() => { try { return JSON.parse(fs.readFileSync(mapPath, "utf8")); } catch { return null; } })();
  // A speaker-policy-only rebuild keeps the same sentence timings and text
  // but necessarily changes raw diarization keys. An operator may explicitly
  // migrate the prior evidence map across that unchanged transcript while
  // the managed LLM is unavailable; row-count compatibility is required and
  // the normal handoff/control validation still runs below.
  const reuseSameTranscriptMap = /^(1|true|yes)$/iu.test(String(process.env.PYA_SPEAKER_REUSE_IDENTITY_MAP || ""))
    && Number(existing?.rows || 0) === rows.length;
  const sourceCompatible = existing?.source_sha256 === sourceSha || reuseSameTranscriptMap;
  if (/^(1|true|yes)$/iu.test(String(process.env.PYA_SPEAKER_AUTHORITATIVE_ONLY || "0"))
      && existing?.schema_version === NAME_MAP_VERSION
      && sourceCompatible
      && Array.isArray(existing?.roster)
      && Array.isArray(existing?.spans)
      && existing.spans.length) {
    const aliases = sanitizeAliasList(existing.aliases, existing.roster);
    const authoritativeSpans = authoritativeCandidateSpans(transcriptDir, prefix, rows, existing.roster);
    const handoffSpans = applyNamedHandoffOverrides(
      removeReferenceOnlySpans(existing.spans, rows, existing.roster),
      rows,
      existing.roster,
      aliases,
    );
    const feedbackSpans = loadIdentityFeedback(transcriptDir, prefix, rows, existing.roster);
    if (authoritativeSpans.length || handoffSpans.length || feedbackSpans.length) {
      const moderator = configuredModeratorName();
      const payload = {
        ...existing,
        source_sha256: sourceSha,
        source_path: speakerJsonPath,
        rows: rows.length,
        roster: canonicalizeModeratorRoster(existing.roster),
        aliases,
        spans: applyModeratorHandoffOverrides(resolveOverlaps([...mergeAuthoritativeSpans(handoffSpans, authoritativeSpans), ...feedbackSpans]), rows, existing.roster, aliases).map((span) => moderator && span.role === "moderator"
          ? { ...span, canonical_name: moderator }
          : span),
        generated_at: new Date().toISOString(),
      };
      fs.writeFileSync(mapPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      writePyaMarker(markerPath, payload);
      process.stdout.write(`[speaker-name-linking] authoritative-only pass: ${authoritativeSpans.length} opening/closing ranges; ${handoffSpans.length} handoff-adjusted spans${reuseSameTranscriptMap ? " (same-transcript identity migration)" : ""}\n`);
    } else {
      throw new Error("authoritative-only speaker pass found no canonical opening/closing markers");
    }
    return;
  }
  if (/^(1|true|yes)$/iu.test(String(process.env.PYA_SPEAKER_NAME_ALIAS_ONLY || "0"))
      && existing?.schema_version === NAME_MAP_VERSION
      && existing?.source_sha256 === sourceSha
      && Array.isArray(existing?.roster)
      && Array.isArray(existing?.spans)
      && existing.spans.length) {
    const previousAliases = sanitizeAliasList(existing.aliases, existing.roster);
    const cleanSpans = removeReferenceOnlySpans(
      removeStaleNamedHandoffSpans(existing.spans, rows, existing.roster, previousAliases),
      rows,
      existing.roster,
    );
    const aliasResponse = await askJson({
      schema: ALIAS_SCHEMA,
      maxTokens: 2200,
      system: "You identify only evidence-backed ASR name variants in a transcript. Return JSON only.",
      prompt: aliasPrompt(rows, existing.roster, cleanSpans, previousAliases),
    });
    let freshAliases = sanitizeAliasList(validateAliases(aliasResponse, rows, existing.roster, cleanSpans), existing.roster);
    const barePrompt = bareNameAliasPrompt(rows, existing.roster, [...previousAliases, ...freshAliases]);
    if (barePrompt) {
      const bareResponse = await askJson({
        schema: ALIAS_SCHEMA,
        maxTokens: 1200,
        system: "You adjudicate short ASR name callouts using adjacent transcript evidence. Return JSON only.",
        prompt: barePrompt,
      });
      const bareAliases = sanitizeAliasList(validateAliases(bareResponse, rows, existing.roster, cleanSpans), existing.roster);
      freshAliases = [...freshAliases, ...bareAliases];
    }
    const bareAliases = inferBareNameAliases(rows, existing.roster, [...previousAliases, ...freshAliases], cleanSpans);
    const inferredAliases = inferUnambiguousFirstNameAliases(rows, existing.roster, [...previousAliases, ...freshAliases, ...bareAliases]);
    const surnameAliases = inferAdjacentSurnameAliases(rows, existing.roster, [...previousAliases, ...freshAliases, ...bareAliases, ...inferredAliases], cleanSpans);
    const aliases = mergeAliasLists(previousAliases, [...freshAliases, ...bareAliases, ...inferredAliases, ...surnameAliases], existing.roster);
    const spans = applyModeratorHandoffOverrides(resolveOverlaps([
      applyNamedHandoffOverrides(cleanSpans, rows, existing.roster, aliases),
      ...loadIdentityFeedback(transcriptDir, prefix, rows, existing.roster),
    ].flat()), rows, existing.roster, aliases);
    const payload = {
      ...existing,
      source_sha256: sourceSha,
      source_path: speakerJsonPath,
      rows: rows.length,
      aliases,
      spans,
      generated_at: new Date().toISOString(),
    };
    fs.writeFileSync(mapPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    writePyaMarker(markerPath, payload);
    process.stdout.write(`[speaker-name-linking] alias-only pass: ${aliases.length} verified aliases\n`);
    return;
  }
  if (!/^(1|true|yes)$/iu.test(String(process.env.PYA_SPEAKER_NAME_LINKING_FORCE || "0"))
      && existing?.schema_version === NAME_MAP_VERSION && existing?.source_sha256 === sourceSha && Array.isArray(existing?.spans)
      && existing.spans.length && Array.isArray(existing?.aliases) && fs.existsSync(markerPath)
      && (!configuredRosterNames().length || configuredRosterNames().every((name) => existing.roster?.some((person) => String(person?.canonical_name || "").toLocaleLowerCase() === name.toLocaleLowerCase())))
      && (!configuredModeratorName() || existing.roster?.some((person) => person?.role === "moderator" && String(person?.canonical_name || "").toLocaleLowerCase() === configuredModeratorName().toLocaleLowerCase()))) {
    process.stdout.write(`[speaker-name-linking] checkpoint pass: ${mapPath}\n`);
    return;
  }

  const rosterResponse = await askJson({
    schema: ROSTER_SCHEMA,
    maxTokens: 3000,
    system: "You are a cautious transcript identity analyst. Return JSON only and never guess a person's name.",
    prompt: candidateRosterPrompt(rows),
  });
  const roster = validateRoster(rosterResponse, rows);
  if (!roster.length) throw new Error("speaker-name linking found no evidence-backed roster");
  process.stdout.write(`[speaker-name-linking] verified roster: ${roster.map((person) => person.canonical_name).join(", ")}\n`);

  const batchRows = Math.max(35, Math.min(140, Math.floor(envNumber("PYA_SPEAKER_NAME_BATCH_ROWS", DEFAULT_BATCH_ROWS))));
  const spans = [];
  for (let start = 0; start < rows.length; start += batchRows) {
    const batch = rows.slice(start, Math.min(rows.length, start + batchRows));
    const batchStart = batch[0].row;
    const batchEnd = batch.at(-1).row;
    const response = await askJson({
      schema: SPAN_SCHEMA,
      // The model must close the JSON object even when it returns several
      // evidence-backed ranges. Keep a generous output budget; the result is
      // still bounded by the schema and is cheaper than retrying a truncated
      // response through the GPU queue.
      maxTokens: Math.max(4200, Math.floor(batch.length * 34)),
      system: "You assign only evidence-backed speaker names to transcript row ranges. Return JSON only.",
      prompt: labelBatchPrompt(batch, roster),
    });
    const valid = validateSpans(response, rows, roster, batchStart, batchEnd);
    spans.push(...valid);
    process.stdout.write(`[speaker-name-linking] rows ${batchStart}-${batchEnd}: ${valid.length} verified ranges\n`);
  }
  let compactSpans = repairHandoffGaps(resolveOverlaps(spans), rows);
  if (!compactSpans.length) throw new Error("speaker-name linking produced no verified ranges");
  const authoritativeSpans = authoritativeCandidateSpans(transcriptDir, prefix, rows, roster);
  if (authoritativeSpans.length) {
    compactSpans = resolveOverlaps([...compactSpans, ...authoritativeSpans]);
    process.stdout.write(`[speaker-name-linking] authoritative opening/closing handoffs: ${authoritativeSpans.length} ranges\n`);
  }
  const feedbackSpans = loadIdentityFeedback(transcriptDir, prefix, rows, roster);
  if (feedbackSpans.length) {
    compactSpans = resolveOverlaps([...compactSpans, ...feedbackSpans]);
    process.stdout.write(`[speaker-name-linking] operator-reviewed identity ranges: ${feedbackSpans.length}\n`);
  }
  const aliasResponse = await askJson({
    schema: ALIAS_SCHEMA,
    maxTokens: 2200,
    system: "You identify only evidence-backed ASR name variants in a transcript. Return JSON only.",
    prompt: aliasPrompt(rows, roster, compactSpans),
  });
  let freshAliases = sanitizeAliasList(validateAliases(aliasResponse, rows, roster, compactSpans), roster);
  const barePrompt = bareNameAliasPrompt(rows, roster, freshAliases);
  if (barePrompt) {
    const bareResponse = await askJson({
      schema: ALIAS_SCHEMA,
      maxTokens: 1200,
      system: "You adjudicate short ASR name callouts using adjacent transcript evidence. Return JSON only.",
      prompt: barePrompt,
    });
    const bareAliases = sanitizeAliasList(validateAliases(bareResponse, rows, roster, compactSpans), roster);
    freshAliases = [...freshAliases, ...bareAliases];
  }
  const bareAliases = inferBareNameAliases(rows, roster, freshAliases, compactSpans);
  const inferredAliases = inferUnambiguousFirstNameAliases(rows, roster, [...freshAliases, ...bareAliases]);
  const surnameAliases = inferAdjacentSurnameAliases(rows, roster, [...freshAliases, ...bareAliases, ...inferredAliases], compactSpans);
  const aliases = mergeAliasLists([], [...freshAliases, ...bareAliases, ...inferredAliases, ...surnameAliases], roster);
  compactSpans = applyModeratorHandoffOverrides(applyNamedHandoffOverrides(compactSpans, rows, roster, aliases), rows, roster, aliases);
  process.stdout.write(`[speaker-name-linking] verified aliases: ${aliases.length}\n`);
  const payload = {
    schema_version: NAME_MAP_VERSION,
    generated_at: new Date().toISOString(),
    source_path: speakerJsonPath,
    source_sha256: sourceSha,
    rows: rows.length,
    roster,
    aliases,
    spans: compactSpans,
  };
  fs.writeFileSync(mapPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  writePyaMarker(markerPath, payload);
  process.stdout.write(`[speaker-name-linking] wrote ${mapPath} (${compactSpans.length} ranges)\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
