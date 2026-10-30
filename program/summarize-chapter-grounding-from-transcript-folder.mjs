#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeCanadianEnglish } from "../../../../program/library/reporter_shared/canadian-english.mjs";
import { normalizeUnambiguousSpokenNumbers } from "../../../../program/library/reporter_shared/grounded-numeric-fidelity.mjs";
import { normalizeSummaryFocus } from "./defaults.mjs";
import { requestManagedOllamaChat } from "../../../../program/runtime/gpu/managed-ollama.mjs";

function usage() {
  process.stdout.write("Usage: node program/summarize-chapter-grounding-from-transcript-folder.mjs <transcript_dir> [prefix] [focus]\n");
}

function pyaEsc(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\"/g, "\\\"");
}

function parseGrounding(pyaText) {
  const out = [];
  const lines = String(pyaText || "").split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^su name chapter grounding unit\s+([^\s]+)\s+since num\s+([0-9.]+)\s+until num\s+([0-9.]+)\s+ob text\s+"([\s\S]+)"\s+ya$/u);
    if (!m) continue;
    let payload = {};
    try { payload = JSON.parse(JSON.parse(`"${m[4]}"`)); } catch { payload = {}; }
    out.push({
      chapterId: String(payload["chapter id"] || m[1]).trim(),
      chapterTitle: String(payload["chapter title"] || "").trim(),
      chapterText: String(payload["chapter text"] || "").trim(),
      since: Number(payload.since ?? m[2]),
      until: Number(payload.until ?? m[3]),
      durationSeconds: Number(payload["duration seconds"]),
      rowStart: Number(payload["row start"]),
      rowEnd: Number(payload["row end"]),
      sourceRows: Number(payload["source rows"]),
      sourceExcerpt: String(payload["source excerpt"] || "").trim(),
    });
  }
  return out.filter((r) => Number.isFinite(r.since) && Number.isFinite(r.until) && r.until >= r.since);
}

function parseExistingSummaryRows(pyaText) {
  const out = new Map();
  const lines = String(pyaText || "").split(/\r?\n/u).map((x) => x.trim()).filter(Boolean);
  for (const line of lines) {
    const m = line.match(/^su name chapter summary unit\s+([^\s]+)\s+since num\s+([0-9.]+)\s+until num\s+([0-9.]+)\s+ob text\s+"([\s\S]+)"\s+ya$/u);
    if (!m) continue;
    try {
      const payload = JSON.parse(JSON.parse(`"${m[4]}"`));
      const chapterId = String(payload?.["chapter id"] || m[1]).trim();
      if (!chapterId) continue;
      out.set(chapterId, {
        chapterId,
        chapterTitle: String(payload?.["chapter title"] || "").trim(),
        since: Number(payload?.since ?? m[2]),
        until: Number(payload?.until ?? m[3]),
        durationSeconds: Number(payload?.["duration seconds"]),
        rowStart: Number(payload?.["row start"]),
        rowEnd: Number(payload?.["row end"]),
        sourceRows: Number(payload?.["source rows"]),
        summary: String(payload?.summary || "").trim(),
      });
    } catch {
      // Ignore malformed cache rows; the chapter will be regenerated below.
    }
  }
  return out;
}

function readCandidateAnswerChapters(transcriptDir, prefix) {
  const filePath = path.join(transcriptDir, `${prefix}.candidate-answer-chapters.json`);
  if (!fs.existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return (Array.isArray(parsed?.answers) ? parsed.answers : [])
      .map((answer) => ({
        candidate: String(answer?.candidate || "").replace(/\s+/gu, " ").trim(),
        startRow: Number(answer?.start_row),
        endRow: Number(answer?.end_row),
        questionTitle: String(answer?.question_title || "").replace(/\s+/gu, " ").trim(),
        summary: String(answer?.summary || "").replace(/\s+/gu, " ").trim(),
      }))
      .filter((answer) => answer.candidate && Number.isInteger(answer.startRow)
        && Number.isInteger(answer.endRow) && answer.endRow >= answer.startRow && answer.summary);
  } catch {
    return [];
  }
}

function candidateEvidenceForUnit(unit, answers) {
  const startRow = Number(unit?.rowStart);
  const endRow = Number(unit?.rowEnd);
  if (!Number.isInteger(startRow) || !Number.isInteger(endRow)) return "";
  const matching = (Array.isArray(answers) ? answers : [])
    .filter((answer) => answer.startRow <= endRow && answer.endRow >= startRow)
    .sort((a, b) => a.startRow - b.startRow || a.endRow - b.endRow);
  if (!matching.length) return "";
  return matching.map((answer) => [
    `${answer.candidate} | rows ${answer.startRow}-${answer.endRow}${answer.questionTitle ? ` | ${answer.questionTitle}` : ""}`,
    answer.summary,
  ].join("\n")).join("\n");
}

async function askOllama({ prompt, system = "You write concrete, source-faithful summaries for transcript chapters.", maxTokens = 140, temperature = 0.2 }) {
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
        options: { num_predict: maxTokens, temperature },
        messages: [
          { role: "system", content: system },
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
      process.stderr.write(`[chapter-summary] managed GPU busy; retry ${attempt + 1}/${attempts} after ${delayMs}ms\n`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError || new Error("managed Ollama request failed");
}

function secondsToHms(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
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
  return normalizeCanadianEnglish(normalizeUnambiguousSpokenNumbers(out.replace(/\s+/gu, " ").trim()));
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

function parseJsonObjectFromModel(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

function rosterNamesFromText(speakerRoster) {
  return String(speakerRoster || "").split(/;+/u).map((name) => name.trim()).filter(Boolean);
}

function applyNameAliases(text, aliases, speakerRoster) {
  let out = String(text || "");
  const allowed = new Set(rosterNamesFromText(speakerRoster).map((name) => name.toLocaleLowerCase()));
  const rows = Array.isArray(aliases) ? aliases : [];
  for (const alias of rows
    .map((item) => ({ observed: String(item?.observed || "").replace(/\s+/gu, " ").trim(), canonical: String(item?.canonical || "").replace(/\s+/gu, " ").trim() }))
    .filter((item) => item.observed.length >= 4 && item.observed.length <= 80)
    .sort((a, b) => b.observed.length - a.observed.length)) {
    const replacement = alias.canonical && allowed.has(alias.canonical.toLocaleLowerCase()) ? alias.canonical : "a candidate";
    const escaped = alias.observed.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    out = out.replace(new RegExp(`\\b${escaped}\\b`, "giu"), replacement);
  }
  return out;
}

async function canonicalizeSpeakerNames({ title, summary, source, speakerRoster }) {
  if (!speakerRoster) return { title, summary };
  const response = await askOllama({
    maxTokens: 500,
    system: "You normalize candidate names in transcript summaries. Return JSON only.",
    prompt: [
      "Return exactly JSON: {\"aliases\":[{\"observed\":string,\"canonical\":string}]}.",
      "List only names in TITLE or SUMMARY that refer to a mayoral candidate or the moderator. Do not list organizations, places, artists, programmes, or other public figures.",
      "Map an ASR spelling to the operator-confirmed canonical name only when the source context supports that identity. If the identity is uncertain, set canonical to an empty string so the renderer can use 'a candidate'. Never invent a canonical name.",
      `OPERATOR-CONFIRMED ROSTER: ${speakerRoster}`,
      `TITLE: ${title}`,
      `SUMMARY: ${summary}`,
      `SOURCE EVIDENCE:\n${String(source || "").slice(0, 10000)}`,
    ].join("\n\n"),
  });
  const parsed = parseJsonObjectFromModel(response);
  const aliases = Array.isArray(parsed?.aliases) ? parsed.aliases : [];
  return {
    title: applyNameAliases(title, aliases, speakerRoster),
    summary: applyNameAliases(summary, aliases, speakerRoster),
  };
}

// Interview chapters can contain off-the-cuff attacks or speculation about
// other candidates. The summary must not silently adopt those claims as the
// narrator's facts, but it should retain useful character and disagreement
// when the source clearly attributes the framing to a speaker.
const PERSONAL_ATTACK_TERMS = [
  "mismanagement", "inexperienced", "collapse", "crooked", "terrorist sympathizer",
  "terrorism sympathizer", "denied 9/11", "worst council", "feel in charge",
  "addicted to power", "witch coven", "hillary clinton", "boomer", "bitches", "degenerate",
  "cracked out", "nothing she's done", "done nothing to fix", "wasteful spending", "waste of public money", "personal mission",
  "failed to fix", "lacks genuine", "staff to run operations", "tired of current leadership",
  "candidate as an outsider", "current council has failed",
  "lacking prior city council tenure", "lack of experience in city governance", "strong conventional communications resume",
  "outsider mayor", "outsider",
  "letting staff run operations", "failing to fix issues", "lacks prior experience", "strong background in conventional communications",
  "allegations that current council", "current council members are",
  "current council's performance", "current council’s performance", "lack of action on",
  "allowing staff to manage operations", "letting the staff run the show", "run the show",
  "worst council ever", "nothing she's done to fix", "nothing to fix it", "doing nothing",
  "situation got worse instead of better", "working against them", "resident expressed anger",
  "personal grievances", "hostile reddit", "defamed me", "find you", "hate these people",
  "feel-good slogans", "she's going to lose badly", "crooked carol", "witch coven",
];

function personalAttackTerms(text = "") {
  const value = String(text || "").toLowerCase();
  return PERSONAL_ATTACK_TERMS.filter((term) => {
    const escaped = String(term).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const re = new RegExp(`(?<![a-z])${escaped}(?![a-z])`, "giu");
    const matches = [...value.matchAll(re)];
    return matches.some((match) => {
      // Preserve a speaker's voice when it is explicitly framed as a claim,
      // criticism, or description. Only un-attributed narrator wording is a
      // blocking defect; the transcript itself remains fully available.
      const start = Math.max(0, Number(match.index || 0) - 100);
      const context = value.slice(start, Number(match.index || 0));
      return !/(?:\b(?:a|one|another|the)\s+(?:candidate|speaker|participant)\b|\b(?:said|says|argued|claims?|described|characteri[sz]ed|critic(?:i[sz]ed|al)|alleged|accused|called|warned|questioned|suggested|raised|according to)\b)/iu.test(context);
    });
  });
}

async function adjudicateTopicOnlyTitle({ unit, title, meetingContext, focus, candidateEvidence = "" }) {
  const source = String(unit?.sourceExcerpt || unit?.chapterText || "").trim();
  let draft = String(title || "").replace(/\s+/gu, " ").trim();
  let lastIssue = "";
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await askOllama({
      maxTokens: 220,
      system: "You adjudicate transcript chapter titles. Return JSON only.",
      prompt: [
        "Return exactly JSON with keys pass (boolean), title (string), issues (array of strings).",
        "The title must be a concise, neutral 3-10 word label for a shared topic or policy discussed in SOURCE.",
        "Hard rule: a chapter window can contain multiple candidates and a moderator. Never include any candidate's, moderator's, host's, guest's, staff member's, or any other person's name in the title. Never include SPEAKER labels. If the draft names a person, replace it with the common topic, policy, service, proposal, or event.",
        "Do not turn one participant's biography, criticism, prediction, or characterization of another person into the title. Use the underlying topic instead.",
        "Set pass true only when the returned title is topic-only and source-grounded. If you rewrite it, return the rewritten title and set pass true when the rewrite is clean.",
        `KNOWN_CONTEXT: ${meetingContext || "Unknown"}`,
        `FOCUS: ${focus || "source-faithful transcript coverage"}`,
        lastIssue ? `PREVIOUS_ISSUE: ${lastIssue}` : "",
        `DRAFT TITLE: ${draft}`,
        candidateEvidence ? `VERIFIED CANDIDATE-ANSWER EVIDENCE (identity and row spans are authoritative):\n${candidateEvidence}` : "",
        `SOURCE:\n${source.slice(0, Number(process.env.ANDRII_CHAPTER_MAX_SOURCE_CHARS || 12000))}`,
      ].filter(Boolean).join("\n\n"),
    });
    const parsed = parseJsonObjectFromModel(response);
    const corrected = String(parsed?.title || "").replace(/\s+/gu, " ").trim();
    const issues = Array.isArray(parsed?.issues)
      ? parsed.issues.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    if (!corrected) {
      lastIssue = "title adjudicator returned an empty title";
      continue;
    }
    draft = corrected;
    if (parsed?.pass === true) return { title: draft, issues };
    lastIssue = issues.join("; ") || "title still contains a person label or is not topic-only";
  }
  throw new Error(`topic-only chapter title adjudication failed: ${lastIssue || "no clean title"}`);
}

function isAuthoritativeIdentityTitle(title) {
  return /^(?:opening|closing):\s*\S/iu.test(String(title || "").trim());
}

async function verifyChapterSummary({ unit, title, summary, meetingContext, focus, speakerRoster = "", authoritativeIdentityTitle = false, candidateEvidence = "" }) {
  const source = String(unit?.sourceExcerpt || unit?.chapterText || "").trim();
  let draftTitle = String(title || "").trim();
  let draftSummary = String(summary || "").trim();
  let lastIssue = "";
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await askOllama({
      maxTokens: 600,
      system: "You are a strict transcript chapter verifier. Return JSON only.",
      prompt: [
        "Validate and correct this chapter title and summary against SOURCE only.",
        "Return JSON only with keys: pass (boolean), title (string), summary (string), issues (array of strings).",
        "Keep the title concise, neutral, and specific (3-10 words); keep the summary to 2-4 complete sentences covering the chapter's distinct substantive topics.",
        authoritativeIdentityTitle
          ? "The supplied title is an authoritative recording marker in the form Opening: or Closing:. Preserve its exact candidate identity and sequence; do not replace it with a generic topic title or another person's name."
          : "Chapter titles must be topic-only and must not contain a candidate's, moderator's, host's, or any other person's name. Replace person-name titles with the shared policy or topic discussed by the participants.",
        "Speaker labels such as SPEAKER_001 are diarization metadata, not identities. Do not infer which label is the named guest or interviewer. Use neutral attribution such as 'one participant says' when needed.",
        "Do not state a participant's criticism, insult, prediction, or characterization as an established narrator fact. Preserve distinctive disagreement when it helps explain the exchange, but attribute it clearly with wording such as 'a candidate argued', 'another speaker described', or 'a participant criticized'.",
        "Do not name a person, organization, location, decision, or outcome unless it is clearly present in SOURCE. Do not merge similarly named candidates or offices.",
        "When VERIFIED CANDIDATE-ANSWER EVIDENCE is present, it is the authoritative attribution map for that chapter. Do not assign one candidate's proposal, experience, or position to another candidate; if the mixed SOURCE window conflicts with that evidence, use the candidate evidence's row spans and wording.",
        "Do not name candidates in the summary unless necessary; prefer 'one candidate' or 'another speaker'. If a candidate must be named, use only an exact spelling from the operator-confirmed roster and never copy an ASR variant from SOURCE.",
        "Preserve proposals, estimates, and uncertainty as proposals, estimates, and uncertainty; never turn them into completed actions or verified conditions.",
        "Cover later details in SOURCE as well as the opening. Do not reduce the chapter to its first exchange.",
        "When SOURCE contains multiple substantive topics or supported figures, cover each briefly rather than omitting later topics; retain exact supported numbers in Arabic digits.",
        "Concise omission of a secondary estimate or example is allowed; do not reject a summary merely because it omits a non-central figure such as an approximate count.",
        "A neutral purpose clause (for example, 'suggests a van to lower pressure downtown') is faithful when SOURCE states that intended purpose; do not require the title to include the word proposal.",
        "Attribution may be omitted when the sentence remains neutral; do not require repeating SPEAKER labels or naming which participant made a proposal.",
        "Using 'proposal', 'plan', or 'suggestion' in a title or summary does not imply adoption or completion. Report numeric claims as estimates or as what a participant says when SOURCE is uncertain; do not reject attributed estimates.",
        "Do not endorse personal attacks or speculative motives in the narrator's voice. If a strongly worded characterization is central to the exchange, retain its character with explicit attribution and make clear that it is the speaker's view.",
        "The safety filter checks attribution, not whether the source contains vivid language: an attributed criticism may remain, while an un-attributed statement of alleged incompetence or mismanagement must be rewritten.",
        "Omitting greetings, occupations, campaign-material anecdotes, and other non-substantive opening context is acceptable; do not flag that omission as an error.",
        "A participant's clearly attributed observation may be reported as an observation even when it is not independently verified; do not demand outside corroboration.",
        speakerRoster ? `Operator-confirmed speaker roster (use these exact spellings whenever the summary names one of these people): ${speakerRoster}` : "",
        attempt >= 4
          ? `Fresh-source retry: ignore the prior wording and write a new source-faithful summary directly from SOURCE. Keep proposals as 'proposes/suggests' and attribute contested characterizations explicitly. Never state these evaluative terms as narrator facts: ${PERSONAL_ATTACK_TERMS.join(", ")}.`
          : "",
        `KNOWN_CONTEXT: ${meetingContext || "Unknown"}`,
        `FOCUS: ${focus || "source-faithful transcript coverage"}`,
        lastIssue ? `PREVIOUS_ISSUE: ${lastIssue}` : "",
        attempt >= 4 ? "PRIOR_DRAFT: (discarded for fresh-source retry)" : `TITLE:\n${draftTitle}`,
        attempt >= 4 ? "PRIOR_SUMMARY: (discarded for fresh-source retry)" : `SUMMARY:\n${draftSummary}`,
        candidateEvidence ? `VERIFIED CANDIDATE-ANSWER EVIDENCE (identity and row spans are authoritative):\n${candidateEvidence}` : "",
        `SOURCE:\n${source.slice(0, Number(process.env.ANDRII_CHAPTER_MAX_SOURCE_CHARS || 16000))}`,
        attempt >= 4
          ? `HARD OUTPUT FILTER: scan the title and summary before returning. If an evaluative term appears without clear attribution to a speaker, rewrite it with explicit attribution or around the concrete policy/topic. Attributed source language may remain. Terms requiring attribution: ${PERSONAL_ATTACK_TERMS.join(", ")}.`
          : "",
      ].filter(Boolean).join("\n\n"),
    });
    const parsed = parseJsonObjectFromModel(response);
    const correctedTitle = String(parsed?.title || "").replace(/\s+/gu, " ").trim();
    const correctedSummary = String(parsed?.summary || "").replace(/\s+/gu, " ").trim();
    const issues = Array.isArray(parsed?.issues)
      ? parsed.issues.map((x) => String(x || "").trim()).filter(Boolean)
      : [];
    if (!correctedTitle || !correctedSummary) {
      lastIssue = "verifier returned an empty title or summary";
      continue;
    }
    draftTitle = correctedTitle;
    draftSummary = correctedSummary;
    const prohibited = personalAttackTerms(`${draftTitle} ${draftSummary}`);
    if (prohibited.length) {
      lastIssue = `personal-attack filter: ${prohibited.join(", ")}`;
      if (attempt >= 2) {
        // Hostile interview windows can be dominated by rhetoric. Ask for a
        // fresh source-only rewrite more than once, explicitly allowing the
        // model to retain just the concrete tool/logistics topic that follows
        // the rhetoric. Never fall back to a deterministic sentence.
        for (let neutralAttempt = 1; neutralAttempt <= 3; neutralAttempt += 1) {
          const neutralRaw = await askOllama({
            maxTokens: 300,
            system: "Rewrite contentious transcript summaries into neutral factual topic descriptions. Return JSON only.",
            prompt: [
              "Return exactly JSON with keys title and summary.",
              "Write a neutral 3-10 word title and 1-2 complete sentences describing only concrete policy proposals, documents, tools, or events in SOURCE.",
              "Do not endorse evaluations of a person's competence, character, motives, popularity, or alleged mismanagement. If one is central to the exchange, preserve the character with explicit attribution such as 'a candidate criticized...' rather than presenting it as fact.",
              "If SOURCE is dominated by hostile or personal remarks, retain only the most relevant attributed characterization and any concrete policy or event, without amplifying insults or inventing motives. If no substantive topic exists, use the neutral title 'Personal remarks and policy discussion' and state that the excerpt contains attributed personal criticism.",
              "For candidate-comparison chapters, summarize only the concrete documents or policy proposals being examined; omit biographies, experience comparisons, and opinions about candidates.",
              "For demographic discussion, use neutral terms such as older residents or younger residents; never repeat pejorative age labels from SOURCE.",
              "Use proposals/suggestions/discussion wording and preserve uncertainty. Do not invent facts or outcomes.",
              `EVALUATIVE TERMS (must be attributed if used): ${PERSONAL_ATTACK_TERMS.join(", ")}`,
              `SOURCE:\n${source.slice(0, Number(process.env.ANDRII_CHAPTER_MAX_SOURCE_CHARS || 12000))}`,
            ].join("\n\n"),
          });
          const neutral = parseJsonObjectFromModel(neutralRaw);
          const neutralTitle = String(neutral?.title || "").replace(/\s+/gu, " ").trim();
          const neutralSummary = String(neutral?.summary || "").replace(/\s+/gu, " ").trim();
          if (neutralTitle && neutralSummary && !personalAttackTerms(`${neutralTitle} ${neutralSummary}`).length) {
            const neutralAdjudication = await askOllama({
              maxTokens: 260,
              temperature: 0.1,
              system: "You adjudicate a neutral transcript topic summary. Return JSON only.",
              prompt: [
                "Return exactly JSON with keys pass and issues.",
                "Pass when the neutral title and summary describe a concrete topic, proposal, document, tool, or event explicitly present in SOURCE, without repeating hostile rhetoric or inventing an outcome.",
                "Do not fail because the summary omits personal remarks or secondary details.",
                `TITLE: ${neutralTitle}`,
                `SUMMARY: ${neutralSummary}`,
                `SOURCE:\n${source.slice(0, Number(process.env.ANDRII_CHAPTER_MAX_SOURCE_CHARS || 12000))}`,
              ].join("\n\n"),
            });
            const neutralDecision = parseJsonObjectFromModel(neutralAdjudication);
            if (neutralDecision?.pass === true) {
              return { title: neutralTitle, summary: neutralSummary, issues: ["contentious source rewritten to neutral topic"] };
            }
            draftTitle = neutralTitle;
            draftSummary = neutralSummary;
            break;
          }
        }
      }
      continue;
    }
    if (parsed?.pass === true) return { title: draftTitle, summary: draftSummary, issues };
    // Mirror the Grey/Owen semantic-review pattern: a second, independent
    // adjudicator distinguishes blocking factual defects from conservative
    // omissions or title/style preferences. This prevents a valid concise
    // chapter from being rejected merely because it omitted a secondary
    // figure, while still blocking invented attribution or outcomes.
    const adjudication = await askOllama({
      maxTokens: 320,
      system: "You adjudicate transcript-summary verification. Return JSON only.",
      prompt: [
        "Decide whether the corrected chapter is publishable against SOURCE.",
        "Return JSON only: {\"pass\":true|false,\"issues\":[\"...\"]}.",
        "Fail only for an invented fact, wrong person or place, changed proposal/uncertainty into a completed outcome, or a personal attack presented as an established fact.",
        "Do not fail for omitting secondary details, using a neutral title, or paraphrasing a participant's clearly attributed observation.",
        "Speaker labels are not identities; do not require naming them.",
        `CORRECTED TITLE: ${draftTitle}`,
        `CORRECTED SUMMARY: ${draftSummary}`,
        candidateEvidence ? `VERIFIED CANDIDATE-ANSWER EVIDENCE:\n${candidateEvidence}` : "",
        `SOURCE: ${source.slice(0, Number(process.env.ANDRII_CHAPTER_MAX_SOURCE_CHARS || 12000))}`,
      ].join("\n\n"),
    });
    const adjudicated = parseJsonObjectFromModel(adjudication);
    if (adjudicated?.pass === true) return { title: draftTitle, summary: draftSummary, issues };
    lastIssue = issues.join("; ") || "verifier rejected one or more chapter claims";
  }
  throw new Error(`chapter summary verification failed: ${lastIssue || "no corrected chapter"}`);
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
  const groundingPath = path.join(transcriptDir, `${prefix}.chapter.grounding.pya`);
  const outPyaPath = path.join(transcriptDir, `${prefix}.chapter-summary.pya`);
  const outMdPath = path.join(transcriptDir, `${prefix}.chapter-summary.md`);
  const verifyPath = path.join(transcriptDir, `${prefix}.chapter-summary.verify.pya`);

  if (!fs.existsSync(groundingPath)) throw new Error(`grounding missing: ${groundingPath}`);
  // A stale marker must never make a failed regeneration look healthy.
  try { fs.rmSync(verifyPath, { force: true }); } catch { /* best effort */ }
  const units = parseGrounding(fs.readFileSync(groundingPath, "utf8"));
  if (!units.length) throw new Error(`no chapter grounding units parsed from ${groundingPath}`);
  const meetingContext = readMeetingContext(transcriptDir);
  const knownLocation = knownLocationFromContext(meetingContext);
  const speakerRoster = canonicalSpeakerRoster();
  const candidateAnswers = readCandidateAnswerChapters(transcriptDir, prefix);
  const reuseExisting = /^(1|true|yes)$/iu.test(String(process.env.ANDRII_CHAPTER_SUMMARY_REUSE || ""));
  const existingSummaries = reuseExisting && fs.existsSync(outPyaPath)
    ? parseExistingSummaryRows(fs.readFileSync(outPyaPath, "utf8"))
    : new Map();

  const sections = [];
  let reusedSections = 0;
  for (const u of units) {
    const cached = existingSummaries.get(u.chapterId);
    const candidateEvidence = candidateEvidenceForUnit(u, candidateAnswers);
    if (
      cached
      && Math.abs(Number(cached.since) - Number(u.since)) < 0.01
      && Math.abs(Number(cached.until) - Number(u.until)) < 0.01
      && cached.summary
      && !personalAttackTerms(`${cached.chapterTitle} ${cached.summary}`).length
    ) {
      let cachedTitle = normalizeKnownLocationErrors(cached.chapterTitle || u.chapterTitle, knownLocation);
      if (isAuthoritativeIdentityTitle(u.chapterTitle)) {
        cachedTitle = normalizeKnownLocationErrors(u.chapterTitle, knownLocation);
      } else try {
        const titleAdjudication = await adjudicateTopicOnlyTitle({
          unit: u,
          title: cachedTitle,
          meetingContext,
          focus,
          candidateEvidence,
        });
        cachedTitle = normalizeKnownLocationErrors(titleAdjudication.title, knownLocation);
      } catch (error) {
        throw new Error(`chapter ${u.chapterId} cached title failed: ${String(error?.message || error)}`);
      }
      sections.push({
        ...u,
        chapterTitle: cachedTitle,
        summary: normalizeKnownLocationErrors(cached.summary, knownLocation),
      });
      reusedSections += 1;
      continue;
    }
    const sourceExcerpt = String(u.sourceExcerpt || u.chapterText || "").trim();
    let summary = "";
    let chapterTitle = u.chapterTitle;
    try {
      const generatedRaw = await askOllama({
        maxTokens: 420,
        system: "You write strictly source-grounded transcript chapter summaries. Return JSON only.",
        prompt: [
        "Return exactly JSON with keys title and summary.",
        "Write a neutral, specific 3-10 word title and 2-4 complete sentences covering the chapter's distinct substantive topics, including details near the end.",
        isAuthoritativeIdentityTitle(u.chapterTitle)
          ? "The supplied SOURCE TITLE is an authoritative recording marker in the form Opening: or Closing:. Preserve that exact candidate identity and sequence in the returned title."
          : "Chapter titles must be topic-only: never include a candidate's, moderator's, host's, or any other person's name, even when the source names a speaker. If the draft title names a person, replace it with the shared policy or topic discussed by the participants.",
          "Speaker labels such as SPEAKER_001 are diarization metadata, not identities. Do not attribute one participant's criticism to the named guest unless the source explicitly identifies that person speaking.",
          "Use proposes, suggests, says, or discusses for proposals and opinions. Do not turn possible causes, estimates, or criticisms into established facts.",
          "Omit insults, personal attacks, speculative motives, and unverified character judgments; retain the underlying topic neutrally.",
          "Do not include evaluations of a person's competence, character, motives, or alleged mismanagement; use a neutral topic title such as 'Affordable housing working group discussion' when the source is contentious.",
          "Do not invent names, places, decisions, outcomes, or numbers. Resolve only obvious place-name ASR errors using KNOWN_CONTEXT.",
          "Do not name candidates in the summary unless necessary; prefer 'one candidate' or 'another speaker'. If a candidate must be named, use only an exact spelling from the operator-confirmed roster and never copy an ASR variant from SOURCE.",
          speakerRoster ? `Operator-confirmed speaker roster (use these exact spellings whenever the summary names one of these people): ${speakerRoster}` : "",
          ...(knownLocation ? [`The subject municipality is ${knownLocation}; do not introduce another municipality unless clearly named in SOURCE.`] : []),
          `KNOWN_CONTEXT: ${meetingContext || "Unknown"}`,
          `FOCUS: ${focus}`,
          `SOURCE TITLE: ${u.chapterTitle}`,
          candidateEvidence ? `VERIFIED CANDIDATE-ANSWER EVIDENCE (identity and row spans are authoritative):\n${candidateEvidence}` : "",
          `SOURCE:\n${sourceExcerpt.slice(0, Number(process.env.ANDRII_CHAPTER_MAX_SOURCE_CHARS || 12000))}`,
        ].join("\n\n"),
      });
      const generated = parseJsonObjectFromModel(generatedRaw);
      summary = normalizeKnownLocationErrors(generated?.summary || "", knownLocation);
      chapterTitle = normalizeKnownLocationErrors(generated?.title || chapterTitle, knownLocation);
      if (!summary || !chapterTitle) throw new Error("initial chapter generation returned empty JSON fields");
      const verified = await verifyChapterSummary({
        unit: u,
        title: chapterTitle,
        summary,
        meetingContext,
        focus,
        speakerRoster,
        authoritativeIdentityTitle: isAuthoritativeIdentityTitle(u.chapterTitle),
        candidateEvidence,
      });
      chapterTitle = normalizeKnownLocationErrors(isAuthoritativeIdentityTitle(u.chapterTitle) ? u.chapterTitle : verified.title, knownLocation);
      summary = normalizeKnownLocationErrors(verified.summary, knownLocation);
      const canonicalized = await canonicalizeSpeakerNames({
        title: chapterTitle,
        summary,
        source: sourceExcerpt,
        speakerRoster,
      });
      chapterTitle = isAuthoritativeIdentityTitle(u.chapterTitle) ? normalizeKnownLocationErrors(u.chapterTitle, knownLocation) : canonicalized.title;
      summary = canonicalized.summary;
    } catch (error) {
      throw new Error(`chapter ${u.chapterId} failed: ${String(error?.message || error)}`);
    }
    try {
      if (!isAuthoritativeIdentityTitle(u.chapterTitle)) {
        const titleAdjudication = await adjudicateTopicOnlyTitle({
          unit: u,
          title: chapterTitle,
          meetingContext,
          focus,
          candidateEvidence,
        });
        chapterTitle = normalizeKnownLocationErrors(titleAdjudication.title, knownLocation);
      } else {
        chapterTitle = normalizeKnownLocationErrors(u.chapterTitle, knownLocation);
      }
    } catch (error) {
      throw new Error(`chapter ${u.chapterId} title failed: ${String(error?.message || error)}`);
    }
    sections.push({
      chapterId: u.chapterId,
      chapterTitle,
      since: u.since,
      until: u.until,
      durationSeconds: Math.max(0, Number(u.until) - Number(u.since)),
      rowStart: u.rowStart,
      rowEnd: u.rowEnd,
      sourceRows: u.sourceRows,
      summary,
    });
  }

  const pyaLines = ["su name chapter summary artifact be series def"];
  for (const s of sections) {
    const payload = {
      "chapter id": s.chapterId,
      "chapter title": s.chapterTitle,
      since: s.since,
      until: s.until,
      "duration seconds": s.durationSeconds,
      "row start": s.rowStart,
      "row end": s.rowEnd,
      "source rows": s.sourceRows,
      summary: s.summary,
    };
    pyaLines.push(`su name chapter summary unit ${s.chapterId} since num ${Number(s.since).toFixed(3)} until num ${Number(s.until).toFixed(3)} ob text "${pyaEsc(JSON.stringify(payload))}" ya`);
  }
  pyaLines.push("prah");

  const md = ["# Chapter Summary", ""];
  for (const [idx, s] of sections.entries()) {
    md.push(`## ${idx + 1}. ${s.chapterTitle}`);
    md.push("");
    md.push(`Time: ${secondsToHms(s.since)} - ${secondsToHms(s.until)}`);
    md.push("");
    md.push(s.summary);
    md.push("");
  }

  fs.writeFileSync(outPyaPath, `${pyaLines.join("\n")}\n`, "utf8");
  fs.writeFileSync(outMdPath, `${md.join("\n")}\n`, "utf8");
  fs.writeFileSync(verifyPath, [
    "su name chapter summary verify artifact be map def",
    "su name pass be bool true ya",
    `su name sections be num ${sections.length} ya`,
    `su name reused sections be num ${reusedSections} ya`,
    `su name speaker roster sha256 be text "${crypto.createHash("sha256").update(speakerRoster, "utf8").digest("hex")}" ya`,
    `su name generated at be text "${pyaEsc(new Date().toISOString())}" ya`,
    "prah",
    "",
  ].join("\n"), "utf8");

  process.stdout.write(`[chapter-summary] grounding: ${groundingPath}\n`);
  process.stdout.write(`[chapter-summary] sections: ${sections.length}\n`);
  process.stdout.write(`[chapter-summary] wrote: ${outPyaPath}\n`);
  process.stdout.write(`[chapter-summary] wrote: ${outMdPath}\n`);
  process.stdout.write(`[chapter-summary] verification: ${verifyPath}\n`);
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
