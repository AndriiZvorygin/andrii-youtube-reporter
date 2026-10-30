#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readPyaTextValues } from "../../../../command/pya_lookup.mjs";

const DEFAULT_ENDPOINT = "https://andrii.zvorygin.ca/api/andrii/v1/meeting-publish";
const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_ROOT = path.resolve(PROGRAM_DIR, "..");
const PYASH_ROOT = path.resolve(PROGRAM_DIR, "../../../..");

function loadSecretTokenFallback() {
  const candidates = [
    path.join(HOUSE_ROOT, "configure/secret.pya"),
    path.join(PYASH_ROOT, "configure/secret.pya"),
    "/home/htaf/pyash/configure/secret.pya",
  ];
  for (const fp of candidates) {
    if (!fs.existsSync(fp)) continue;
    const values = readPyaTextValues(fp, [
      "andrii meeting publish token",
      "meeting publish token",
      "andrii meeting publish auth token",
      "meeting publish auth token",
      "MEETING_PUBLISH_TOKEN",
      "MEETING_PUBLISH_AUTH_TOKEN",
    ]);
    const token = String(
      values["andrii meeting publish token"]
      || values["meeting publish token"]
      || values["andrii meeting publish auth token"]
      || values["meeting publish auth token"]
      || values.MEETING_PUBLISH_TOKEN
      || values.MEETING_PUBLISH_AUTH_TOKEN
      || "",
    ).trim();
    if (token) return token;
  }
  return "";
}

function parseDotEnvText(src) {
  const out = {};
  const lines = String(src || "").split(/\r?\n/u);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function readEnvFileIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  return parseDotEnvText(fs.readFileSync(filePath, "utf8"));
}

function loadEnvFallbacks(cwdDir) {
  const start = path.resolve(cwdDir);
  const dirs = [];
  let cur = start;
  while (true) {
    dirs.push(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  const merged = {};
  for (const dir of dirs.reverse()) {
    Object.assign(merged, readEnvFileIfExists(path.join(dir, ".env")));
  }
  return merged;
}

function usage() {
  return [
    "Usage: node program/publish-meeting-to-andrii-from-payload.mjs <lemmy_payload_json> [community_name] [idempotency_key] [post_ref] [extras_json] [dry_run]",
  ].join("\n");
}

function slugify(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "unknown";
}

function resolveMaybeRelative(baseDir, rawPath) {
  const p = String(rawPath || "").trim();
  if (!p) return "";
  if (path.isAbsolute(p)) return p;
  return path.resolve(baseDir, p);
}

function parsePostRef(postRefRaw) {
  const postRef = String(postRefRaw || "").trim();
  if (!postRef) return { post_id: "", post_url: "", article_url: "" };
  if (/^\d+$/u.test(postRef)) return { post_id: String(Number(postRef)), post_url: "", article_url: "" };
  if (/^https?:\/\//iu.test(postRef)) {
    if (/\/streams\//iu.test(postRef)) return { post_id: "", post_url: "", article_url: postRef };
    return { post_id: "", post_url: postRef, article_url: "" };
  }
  return { post_id: "", post_url: "", article_url: "" };
}

function buildIdempotencyKey({ source, topic, dateIso, postTitle, summary, suffix, explicit }) {
  const ex = String(explicit || "").trim();
  if (ex) return ex;
  const base = `${slugify(source)}-${slugify(topic)}-${String(dateIso || "").trim() || "unknown-date"}`;
  const digest = crypto
    .createHash("sha256")
    .update(`${String(postTitle || "")}\n${String(summary || "")}\n${String(suffix || "")}`, "utf8")
    .digest("hex")
    .slice(0, 8);
  return `${base}-${digest}-v1`;
}

function extractCanonicalHref(html) {
  const m = String(html || "").match(/<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/iu);
  return m ? String(m[1]).trim() : "";
}

function hasMetaDescription(html) {
  return /<meta\s+name=["']description["']\s+content=["'][^"']+["']/iu.test(String(html || ""));
}

function hasTitleTag(html) {
  return /<title>[\s\S]*?<\/title>/iu.test(String(html || ""));
}

function hasVisibleH1(html) {
  return /<h1[^>]*>[\s\S]*?<\/h1>/iu.test(String(html || ""));
}

function hasRequiredSection(html, sectionName) {
  const esc = String(sectionName || "").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`<h2[^>]*>\\s*${esc}(?:\\s|&amp;|&[a-z]+;|[^<])*<\\/h2>`, "iu").test(String(html || ""));
}

function stripDisallowedTags(html) {
  let out = String(html || "");
  out = out.replace(/<script\b[\s\S]*?<\/script>/giu, "");
  out = out.replace(/<iframe\b[\s\S]*?<\/iframe>/giu, "");
  out = out.replace(/<object\b[\s\S]*?<\/object>/giu, "");
  out = out.replace(/\son[a-z]+\s*=\s*(".*?"|'.*?'|[^\s>]+)/giu, "");
  return out;
}

function ensureDiscussionPlaceholder(html) {
  const src = String(html || "");
  if (src.includes("{{DISCUSSION_URL}}")) return src;
  if (/<\/main>/iu.test(src)) {
    return src.replace(/<\/main>/iu, '<section><h2>Discussion</h2><p><a href="{{DISCUSSION_URL}}">Discuss this stream summary</a></p></section>\n</main>');
  }
  if (/<\/body>/iu.test(src)) {
    return src.replace(/<\/body>/iu, '<p><a href="{{DISCUSSION_URL}}">Discuss this stream summary</a></p>\n</body>');
  }
  return `${src}\n<p><a href="{{DISCUSSION_URL}}">Discuss this stream summary</a></p>\n`;
}

function parseExtras(raw) {
  const txt = String(raw || "").trim();
  if (!txt) return null;
  if (txt.startsWith("@")) {
    const fp = path.resolve(process.cwd(), txt.slice(1));
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  }
  return JSON.parse(txt);
}

function toAbsTranscriptUrl(siteUrl, source, topic, dateIso, suffix = "") {
  const dateSlug = `${dateIso}${suffix ? `-${slugify(suffix)}` : ""}`;
  return `${String(siteUrl || "https://andrii.zvorygin.ca").replace(/\/+$/u, "")}/transcripts/${slugify(source)}/${slugify(topic)}/${dateSlug}`;
}

function normalizeKeyTopics(value) {
  if (Array.isArray(value)) return value.map((x) => String(x || "").trim()).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/\r?\n/u).map((x) => x.replace(/^[\-\*\d\.\)\s]+/u, "").trim()).filter(Boolean);
  }
  return [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function parseRetryAfterMs(headerValue) {
  const raw = String(headerValue || "").trim();
  if (!raw) return 0;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.round(sec * 1000);
  const when = Date.parse(raw);
  if (!Number.isFinite(when)) return 0;
  return Math.max(0, when - Date.now());
}

function isRateLimited(status, parsedBody) {
  if (Number(status) === 429) return true;
  const err = String(parsedBody?.error || "").trim().toLowerCase();
  return err === "rate_limit_error";
}

function withAttemptSuffix(idempotencyKeyBase, attempt) {
  const base = String(idempotencyKeyBase || "").trim();
  if (!base) return "";
  const n = Number(attempt) || 1;
  return n <= 1 ? base : `${base}-r${n}`;
}

async function main() {
  const payloadArg = process.argv[2];
  const communityArg = process.argv[3] || "";
  const idempotencyArg = process.argv[4] || "";
  const postRefArg = process.argv[5] || "";
  const extrasArg = process.argv[6] || "";
  const dryRunArg = process.argv[7] || "";

  if (!payloadArg) {
    process.stdout.write(`${usage()}\n`);
    process.exit(2);
  }

  const endpoint = String(process.env.MEETING_PUBLISH_ENDPOINT || DEFAULT_ENDPOINT).trim();
  const envFallback = loadEnvFallbacks(process.cwd());
  const secretTokenFallback = loadSecretTokenFallback();
  const token = String(
    process.env.MEETING_PUBLISH_TOKEN
    || secretTokenFallback
    || process.env.MEETING_PUBLISH_AUTH_TOKEN
    || envFallback.MEETING_PUBLISH_TOKEN
    || envFallback.MEETING_PUBLISH_AUTH_TOKEN
    || "",
  ).trim();
  const dryRun = /^(1|true|yes)$/iu.test(String(process.env.MEETING_PUBLISH_DRY_RUN || dryRunArg || "0"));
  const maxAttempts = Math.max(1, Number.parseInt(String(process.env.MEETING_PUBLISH_MAX_ATTEMPTS || envFallback.MEETING_PUBLISH_MAX_ATTEMPTS || "6"), 10) || 6);
  const baseRetryDelayMs = Math.max(1_000, Number.parseInt(String(process.env.MEETING_PUBLISH_RETRY_DELAY_MS || envFallback.MEETING_PUBLISH_RETRY_DELAY_MS || "30000"), 10) || 30_000);
  const retryJitterMs = Math.max(0, Number.parseInt(String(process.env.MEETING_PUBLISH_RETRY_JITTER_MS || envFallback.MEETING_PUBLISH_RETRY_JITTER_MS || "2000"), 10) || 2_000);

  const payloadPath = path.resolve(process.cwd(), payloadArg);
  const payloadDir = path.dirname(payloadPath);
  const payload = JSON.parse(fs.readFileSync(payloadPath, "utf8"));

  const source = String(payload?.source || payload?.jurisdiction || "andrii-zvorygin").trim();
  const topic = String(payload?.topic || payload?.body || "general").trim();
  const dateIso = String(payload?.date_iso || "").trim();
  const suffix = String(payload?.suffix || "").trim();
  const postTitle = String(payload?.post_title || payload?.title || "").trim();
  const summary = String(payload?.summary || payload?.hook || "").trim();
  const keyTopics = normalizeKeyTopics(payload?.key_topics);
  const communityName = String(process.env.MEETING_PUBLISH_COMMUNITY_NAME || envFallback.MEETING_PUBLISH_COMMUNITY_NAME || communityArg || payload?.community_name || "andrii-zvorygin").trim();
  const siteUrl = String(process.env.MEETING_PUBLISH_SITE_URL || envFallback.MEETING_PUBLISH_SITE_URL || "https://andrii.zvorygin.ca").trim();

  if (!source || !topic || !dateIso || !postTitle || !summary || !keyTopics.length) {
    throw new Error("payload missing required fields: source/topic/date_iso/post_title/summary/key_topics");
  }

  const postRefEnv = String(process.env.MEETING_PUBLISH_POST_REF || envFallback.MEETING_PUBLISH_POST_REF || "").trim();
  const parsedRef = parsePostRef(postRefEnv || postRefArg || payload?.post_id || payload?.post_url || payload?.article_url || "");
  const updateMode = Boolean(parsedRef.post_id || parsedRef.post_url || parsedRef.article_url);

  const idempotencyKeyBase = buildIdempotencyKey({
    source,
    topic,
    dateIso,
    postTitle,
    summary,
    suffix,
    explicit: process.env.MEETING_PUBLISH_IDEMPOTENCY_KEY || envFallback.MEETING_PUBLISH_IDEMPOTENCY_KEY || idempotencyArg || payload?.idempotency_key,
  });

  const htmlSourcePath = resolveMaybeRelative(payloadDir, payload?.local_transcript_html);
  if (!htmlSourcePath || !fs.existsSync(htmlSourcePath)) {
    throw new Error(`transcript html not found: ${String(payload?.local_transcript_html || "")}`);
  }
  const imageSourcePath = resolveMaybeRelative(payloadDir, payload?.local_cover_image);

  let html = fs.readFileSync(htmlSourcePath, "utf8");
  html = stripDisallowedTags(html);
  html = ensureDiscussionPlaceholder(html);

  if (!hasTitleTag(html)) throw new Error("transcript_html missing <title>");
  if (!hasMetaDescription(html)) throw new Error("transcript_html missing meta description");
  if (!hasVisibleH1(html)) throw new Error("transcript_html missing visible <h1>");
  if (!hasRequiredSection(html, "Summary")) throw new Error("transcript_html missing Summary section");
  if (!hasRequiredSection(html, "Key Topics")) throw new Error("transcript_html missing Key Topics section");
  if (!hasRequiredSection(html, "Full Transcript")) throw new Error("transcript_html missing Full Transcript section");
  if (!html.includes("{{DISCUSSION_URL}}")) throw new Error("transcript_html missing {{DISCUSSION_URL}} token");

  const expectedCanonical = toAbsTranscriptUrl(siteUrl, source, topic, dateIso, suffix);
  const foundCanonical = extractCanonicalHref(html);
  if (!foundCanonical) throw new Error("transcript_html missing canonical link");
  if (foundCanonical !== expectedCanonical) {
    throw new Error(`canonical mismatch: found=${foundCanonical} expected=${expectedCanonical}`);
  }

  const uploadHtmlPath = path.join(payloadDir, `${path.basename(htmlSourcePath, path.extname(htmlSourcePath))}.meeting-publish.html`);
  fs.writeFileSync(uploadHtmlPath, html, "utf8");

  const metadataBase = {
    source: slugify(source),
    topic: slugify(topic),
    date_iso: dateIso,
    suffix,
    community_name: communityName,
    post_title: postTitle,
    summary,
    key_topics: keyTopics,
  };
  if (suffix) metadataBase.suffix = suffix;
  if (parsedRef.post_id) metadataBase.post_id = parsedRef.post_id;
  if (parsedRef.post_url) metadataBase.post_url = parsedRef.post_url;
  if (parsedRef.article_url) metadataBase.article_url = parsedRef.article_url;

  const extras = parseExtras(process.env.MEETING_PUBLISH_EXTRAS_JSON || envFallback.MEETING_PUBLISH_EXTRAS_JSON || extrasArg)
    || {
      source_url: String(payload?.source_links?.meeting_url || payload?.source_links?.video_url || payload?.source_url || ""),
      source_recording_url: String(payload?.source_links?.video_url || payload?.source_url || ""),
      hook: String(payload?.hook || ""),
    };

  process.stdout.write(`[meeting-publish] mode: ${updateMode ? "UPDATE" : "CREATE"}\n`);
  process.stdout.write(`[meeting-publish] endpoint: ${endpoint}\n`);
  process.stdout.write(`[meeting-publish] transcript_html: ${uploadHtmlPath}\n`);
  process.stdout.write(`[meeting-publish] idempotency_key_base: ${idempotencyKeyBase}\n`);

  if (dryRun) {
    process.stdout.write("[meeting-publish] dry-run enabled, request not sent.\n");
    process.exit(0);
  }
  if (!token) throw new Error("MEETING_PUBLISH_TOKEN is required unless dry-run");

  function buildMultipartForm(metadata) {
    const form = new FormData();
    form.append("metadata", JSON.stringify(metadata));
    form.append("transcript_html", new Blob([html], { type: "text/html; charset=utf-8" }), path.basename(uploadHtmlPath));
    if (imageSourcePath && fs.existsSync(imageSourcePath)) {
      const imageBuf = fs.readFileSync(imageSourcePath);
      const ext = path.extname(imageSourcePath).toLowerCase();
      const contentType = ext === ".png" ? "image/png" : ((ext === ".jpg" || ext === ".jpeg") ? "image/jpeg" : "application/octet-stream");
      form.append("cover_image", new Blob([imageBuf], { type: contentType }), path.basename(imageSourcePath));
    }
    if (extras) form.append("extras_json", JSON.stringify(extras));
    return form;
  }

  const responsePath = path.join(payloadDir, `${path.basename(payloadPath, path.extname(payloadPath))}.meeting-publish.response.json`);
  let parsed = null;
  let raw = "";
  let finalStatus = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const idempotencyKey = withAttemptSuffix(idempotencyKeyBase, attempt);
    const metadata = { ...metadataBase, idempotency_key: idempotencyKey };
    process.stdout.write(`[meeting-publish] attempt ${attempt}/${maxAttempts} key=${idempotencyKey}\n`);
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: buildMultipartForm(metadata),
      signal: AbortSignal.timeout(5 * 60 * 1000),
    });
    raw = await res.text();
    parsed = null;
    finalStatus = Number(res.status) || 0;
    try { parsed = JSON.parse(raw); } catch {}

    fs.writeFileSync(responsePath, `${parsed ? JSON.stringify(parsed, null, 2) : raw}\n`, "utf8");
    if (res.ok) break;

    const retryable = isRateLimited(res.status, parsed) || Number(res.status) >= 500;
    if (!retryable || attempt >= maxAttempts) {
      throw new Error(`meeting-publish failed (${res.status}): ${raw.slice(0, 1200)}`);
    }
    const retryAfterMs = parseRetryAfterMs(res.headers.get("retry-after"));
    const jitterMs = retryJitterMs > 0 ? Math.floor(Math.random() * (retryJitterMs + 1)) : 0;
    const waitMs = Math.max(baseRetryDelayMs + jitterMs, retryAfterMs);
    await sleep(waitMs);
  }

  if (finalStatus < 200 || finalStatus >= 300) {
    throw new Error(`meeting-publish failed (${finalStatus}): ${raw.slice(0, 1200)}`);
  }

  if (parsed && typeof parsed === "object") {
    if (parsed.post_url) process.stdout.write(`[meeting-publish] post_url: ${parsed.post_url}\n`);
    if (parsed.article_url) process.stdout.write(`[meeting-publish] article_url: ${parsed.article_url}\n`);
    if (parsed.transcript_url) process.stdout.write(`[meeting-publish] transcript_url: ${parsed.transcript_url}\n`);
    if (typeof parsed.idempotent_replay === "boolean") {
      process.stdout.write(`[meeting-publish] idempotent_replay: ${String(parsed.idempotent_replay)}\n`);
    }
  }
}

main().catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
