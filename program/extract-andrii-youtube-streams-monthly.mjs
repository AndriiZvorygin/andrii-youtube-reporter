#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ANDRII_ADAPTER } from "./writer-adapter-andrii-youtube.mjs";
import { activeYoutubeSourceProfile } from "./youtube-source-profiles.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_ROOT = path.resolve(PROGRAM_DIR, "..");
const MONTHLY_DIR = path.join(HOUSE_ROOT, "artifacts/andrii-youtube/monthly");
const YTDLP_UPDATE_STAMP = path.join(MONTHLY_DIR, ".yt-dlp-update-stamp");

function envFlag(name, fallback = false) {
  const raw = String(process.env[name] ?? "").trim().toLowerCase();
  if (!raw) return fallback;
  return ["1", "true", "yes", "on"].includes(raw);
}

function ytDlpArgs(baseArgs = []) {
  const extractorArgs = String(process.env.ANDRII_YTDLP_EXTRACTOR_ARGS || "youtube:player_client=android").trim();
  if (!extractorArgs) return [...baseArgs];
  return [...baseArgs, "--extractor-args", extractorArgs];
}

function firstYtDlpError(err) {
  const text = String(err?.stderr || err?.stdout || err?.message || err || "");
  const line = text.split(/\r?\n/u).map((s) => s.trim()).find((s) => s);
  return line || "unknown yt-dlp error";
}

function maybeUpdateYtDlp() {
  if (!envFlag("ANDRII_YTDLP_AUTO_UPDATE", true)) return;
  fs.mkdirSync(MONTHLY_DIR, { recursive: true });
  const intervalMs = Number(process.env.ANDRII_YTDLP_UPDATE_INTERVAL_MS || 12 * 60 * 60 * 1000);
  const last = fs.statSync(YTDLP_UPDATE_STAMP, { throwIfNoEntry: false });
  if (last && Date.now() - Number(last.mtimeMs || 0) < intervalMs) return;

  try {
    const bin = execFileSync("sh", ["-lc", "command -v yt-dlp"], { encoding: "utf8", timeout: 10_000 }).trim();
    if (bin) {
      try {
        const owner = execFileSync("dpkg", ["-S", bin], { encoding: "utf8", timeout: 10_000 }).trim();
        if (/^yt-dlp:/u.test(owner)) {
          process.stdout.write("[yt-dlp] auto-update skipped: apt-managed install\n");
          return;
        }
      } catch {
        // Non-Debian or non-package-managed install; fall through to yt-dlp -U.
      }
    }
    const before = execFileSync("yt-dlp", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    process.stdout.write(`[yt-dlp] checking for updates (current=${before || "unknown"})\n`);
    const out = execFileSync("yt-dlp", ["-U"], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: Number(process.env.ANDRII_YTDLP_UPDATE_TIMEOUT_MS || 120_000),
    }).trim();
    if (out) process.stdout.write(`${out}\n`);
  } catch (err) {
    const msg = String(err?.stderr || err?.stdout || err?.message || err).trim().split(/\r?\n/u).slice(0, 3).join(" ");
    process.stderr.write(`[yt-dlp] warn: update skipped/failed: ${msg}\n`);
  } finally {
    fs.writeFileSync(YTDLP_UPDATE_STAMP, `${new Date().toISOString()}\n`, "utf8");
  }
}

function toSinceDate(entry) {
  const ts = Number(entry?.release_timestamp || entry?.timestamp || 0);
  if (Number.isFinite(ts) && ts > 0) {
    const d = new Date(ts * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${y}-${m}-${day}T${hh}:${mm}:${ss}`;
  }

  const up = String(entry?.upload_date || "").trim();
  const now = new Date();
  const todayYmd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;

  // yt-dlp often omits release/timestamp for fresh finished livestreams.
  // Only apply back-calc for *today's* post-live items to avoid shifting history.
  const liveStatus = String(entry?.live_status || "").trim().toLowerCase();
  const looksFinishedLive = entry?.was_live === true || liveStatus === "post_live" || liveStatus === "was_live";
  const durationSeconds = Number(entry?.duration || 0);
  if (looksFinishedLive && /^\d{8}$/u.test(up) && up === todayYmd) {
    const backSeconds = Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : 2 * 60 * 60;
    const d = new Date(now.getTime() - backSeconds * 1000);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${y}-${m}-${day}T${hh}:${mm}:${ss}`;
  }

  if (/^\d{8}$/u.test(up)) {
    return `${up.slice(0, 4)}-${up.slice(4, 6)}-${up.slice(6, 8)}T12:00:00`;
  }
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}T12:00:00`;
}
function plusHours(isoLocal, hours = 1) {
  const d = new Date(String(isoLocal).replace("T", " "));
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return isoLocal;
  d.setHours(d.getHours() + hours);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}:${ss}`;
}

function pyaEsc(text) {
  return String(text || "").replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function probeVideoMeta(url) {
  try {
    const raw = execFileSync("yt-dlp", ytDlpArgs([
      "--quiet",
      "--dump-single-json",
      "--no-warnings",
      "--skip-download",
      url,
    ]), {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      timeout: Number(process.env.ANDRII_YTDLP_PROBE_TIMEOUT_MS || 12_000),
      killSignal: "SIGKILL",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(String(raw || "{}"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (err) {
    process.stderr.write(`[yt-dlp] skip probe ${url}: ${firstYtDlpError(err)}\n`);
    return null;
  }
}

function isLivestreamLike(meta) {
  if (!meta || typeof meta !== "object") return false;
  if (meta.was_live === true) return true;
  if (meta.is_live === true) return true;
  const liveStatus = String(meta.live_status || "").toLowerCase();
  if (liveStatus === "is_live" || liveStatus === "was_live" || liveStatus === "post_live") return true;
  return false;
}

function channelBaseUrl(channelUrl) {
  return String(channelUrl || "").replace(/\/(?:streams|live|videos)\/?$/u, "");
}

function main() {
  fs.mkdirSync(MONTHLY_DIR, { recursive: true });
  maybeUpdateYtDlp();
  const channel = activeYoutubeSourceProfile().source_channel_url
    || ANDRII_ADAPTER.defaults?.source_channel_url
    || "https://www.youtube.com/@AndriiZ/streams";
  const baseChannel = channelBaseUrl(channel);
  const candidates = [
    { url: channel, kind: "streams", includeRegularVideos: false },
    { url: `${baseChannel}/live`, kind: "live", includeRegularVideos: false },
    { url: `${baseChannel}/videos`, kind: "videos", includeRegularVideos: true },
  ];
  const feeds = [];
  let lastErr = "";
  for (const candidate of candidates) {
    try {
      const raw = execFileSync("yt-dlp", ytDlpArgs([
        "--quiet",
        "--ignore-errors",
        "--dump-single-json",
        "--flat-playlist",
        "--playlist-end", "40",
        candidate.url,
      ]), {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const parsed = JSON.parse(String(raw || "{}"));
      if (Array.isArray(parsed?.entries) && parsed.entries.length) {
        feeds.push({ ...candidate, entries: parsed.entries });
      }
    } catch (err) {
      lastErr = String(err?.stderr || err?.message || err);
    }
  }
  if (!feeds.length) {
    throw new Error(`youtube discovery failed (tried streams/live/videos): ${lastErr || "unknown error"}`);
  }
  const out = [];

  let inspected = 0;
  const MAX_INSPECTED_PER_FEED = Number(process.env.ANDRII_YT_MAX_INSPECTED_PER_FEED || process.env.ANDRII_YT_MAX_INSPECTED || 12);
  const MAX_OUT = Number(process.env.ANDRII_YT_MAX_OUT || 20);
  const seenIds = new Set();
  for (const feed of feeds) {
    let feedInspected = 0;
    for (const e of feed.entries) {
      if (feedInspected >= MAX_INSPECTED_PER_FEED) break;
      const id = String(e?.id || "").trim();
      if (!/^[A-Za-z0-9_-]{11}$/u.test(id)) continue;
      if (seenIds.has(id)) continue;
      feedInspected += 1;
      inspected += 1;
      const url = `https://www.youtube.com/watch?v=${id}`;
      const meta = probeVideoMeta(url);
      if (!meta) continue;
      const live = isLivestreamLike(meta);
      if (!live && !feed.includeRegularVideos) continue;
      seenIds.add(id);
      const title = String(meta?.title || e?.title || `${live ? "Livestream" : "Video"} ${id}`).trim()
        || `${live ? "Livestream" : "Video"} ${id}`;
      const since = toSinceDate(meta);
      const until = plusHours(since, 2);
      const payload = {
        meeting_id: id,
        meeting_name: title,
        meeting_type: live ? "YouTube Livestream" : "YouTube Video",
        meeting_url: url,
        source_url: url,
        video: [url],
        video_player: [url],
        video_direct: [url],
        agenda: [],
        agenda_cover: [],
        minutes: [],
        source: live ? "youtube-live" : "youtube-video",
        channel_url: feed.url,
        uploader: String(meta?.uploader || ""),
        channel: String(meta?.channel || ""),
        duration_seconds: Number(meta?.duration || 0) || null,
        live_status: String(meta?.live_status || ""),
        was_live: meta?.was_live === true,
      };
      out.push({
        suName: `andrii youtube event ${id}`,
        since,
        until,
        payload,
      });
    }
  }

  out.sort((a, b) => String(a.since).localeCompare(String(b.since)));
  const selected = out.slice(-MAX_OUT);
  const lines = ["su name andrii youtube events be series def"];
  for (const row of selected) {
    const payloadJson = JSON.stringify(row.payload);
    lines.push(`su name ${row.suName} since date ${row.since} until date ${row.until} ob text "${pyaEsc(payloadJson)}" ya`);
  }
  lines.push("prah");
  const outPath = path.join(MONTHLY_DIR, "youtube-streams.events.series.pya");
  fs.writeFileSync(outPath, `${lines.join("\n")}\n`, "utf8");
  process.stdout.write(`wrote ${selected.length} events into 1 month files at ${MONTHLY_DIR} (feeds=${feeds.map((feed) => feed.kind).join(",")}, inspected=${inspected}, discovered=${out.length})\n`);
}

main();
