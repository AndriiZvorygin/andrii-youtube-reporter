import fs from "node:fs";

const CHAPTER_LINE_RE = /^(\s*)(\d+):(\d{2})(?::(\d{2}))?(\s+)(.+?)\s*$/u;

export function parseChapterTimestamp(value = "") {
  const match = String(value || "").trim().match(/^(\d+):(\d{2})(?::(\d{2}))?$/u);
  if (!match) return null;
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? 0);
  if (!Number.isInteger(minutes) || minutes > 59 || !Number.isInteger(seconds) || seconds > 59) return null;
  return Number(match[1]) * (match[3] == null ? 60 : 3600) + minutes * (match[3] == null ? 1 : 60) + seconds;
}

export function formatChapterTimestamp(seconds, { first = false } = {}) {
  if (first) return "00:00";
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

export function normalizeChapterText(text = "") {
  const lines = String(text || "").split(/\r?\n/u);
  let foundFirst = false;
  let changed = false;
  const normalized = lines.map((line) => {
    const match = line.match(CHAPTER_LINE_RE);
    if (!match) return line;
    const timestamp = `${match[2]}:${match[3]}${match[4] == null ? "" : `:${match[4]}`}`;
    const seconds = parseChapterTimestamp(timestamp);
    if (seconds == null || foundFirst) return line;
    foundFirst = true;
    const replacement = `${match[1]}00:00${match[5]}${match[6]}`;
    if (replacement !== line) changed = true;
    return replacement;
  });
  return changed ? normalized.join("\n") : String(text || "");
}

export function chapterTextStartsAtZero(text = "") {
  const first = String(text || "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => CHAPTER_LINE_RE.test(line));
  return Boolean(first && /^00:00\s+\S/u.test(first));
}

// An optional authoritative chapter list may be supplied by the source
// publisher (for example, chapters copied from the official recording).  It
// is deliberately an input artifact rather than a meeting-specific rule: any
// future transcript can opt in by placing one of the conventional files below
// next to its transcript, or by setting PYA_AUTHORITATIVE_CHAPTERS_PATH.
export function findAuthoritativeChapterFile(transcriptDir, prefix = "") {
  const explicit = String(process.env.PYA_AUTHORITATIVE_CHAPTERS_PATH || "").trim();
  const candidates = [
    explicit,
    prefix ? `${transcriptDir}/${prefix}.official-chapters.txt` : "",
    prefix ? `${transcriptDir}/${prefix}.authoritative-chapters.txt` : "",
    `${transcriptDir}/official-chapters.txt`,
    `${transcriptDir}/authoritative-chapters.txt`,
  ].filter(Boolean);
  return candidates.find((filePath) => {
    try { return fs.existsSync(filePath) && fs.statSync(filePath).isFile(); } catch { return false; }
  }) || "";
}

export function parseAuthoritativeChapterText(text = "") {
  const out = [];
  for (const rawLine of String(text || "").split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+:(?:\d{2})(?::\d{2})?)\s+(.+?)\s*$/u);
    if (!match) continue;
    const since = parseChapterTimestamp(match[1]);
    const title = String(match[2] || "").replace(/\s+/gu, " ").trim();
    if (since == null || !title) continue;
    if (out.length && since <= out[out.length - 1].since) {
      throw new Error(`authoritative chapters must be strictly increasing (at ${match[1]})`);
    }
    out.push({ since, title });
  }
  if (out.length && out[0].since !== 0) {
    throw new Error("authoritative chapters must begin at 0:00");
  }
  return out;
}

export function normalizeChapterTextFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const original = fs.readFileSync(filePath, "utf8");
  const normalized = normalizeChapterText(original);
  if (normalized === original) return false;
  fs.writeFileSync(filePath, normalized, "utf8");
  return true;
}
