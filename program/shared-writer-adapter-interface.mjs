import path from "node:path";

const REQUIRED_KEYS = [
  "writer_id",
  "source_id",
  "house_root",
  "artifacts_slug",
  "refresh_calendar_cmd",
  "run_meeting_from_ref_cmd",
  "send_dm_cmd",
  "identity",
  "defaults",
];

export function defineWriterAdapter(spec = {}) {
  const obj = spec && typeof spec === "object" ? spec : {};
  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) throw new Error(`writer adapter defective: missing ${key}`);
  }
  if (!obj.identity || typeof obj.identity !== "object") {
    throw new Error("writer adapter defective: identity must be object");
  }
  return Object.freeze({ ...obj });
}

export function buildRunNextConfig(adapter, {
  basePrefix,
  focus,
  jurisdiction,
  body,
  siteUrl,
  discussionUrl,
  execMxid,
  timezone,
  extra = {},
} = {}) {
  const d = adapter.defaults || {};
  const houseRoot = String(adapter.house_root || "").trim();
  const artifactsSlug = String(adapter.artifacts_slug || "").trim();
  return {
    house_root: houseRoot,
    monthly_dir: path.join(houseRoot, "artifacts", artifactsSlug, "monthly"),
    meetings_dir: path.join(houseRoot, "artifacts", artifactsSlug, "meetings"),
    refresh_calendar_cmd: adapter.refresh_calendar_cmd,
    run_meeting_from_ref_cmd: adapter.run_meeting_from_ref_cmd,
    send_dm_cmd: adapter.send_dm_cmd,
    base_prefix: basePrefix || d.base_prefix,
    focus: focus || d.focus,
    jurisdiction: jurisdiction || d.jurisdiction,
    body: body || d.body,
    site_url: siteUrl || d.site_url,
    discussion_url: discussionUrl || d.discussion_url,
    exec_mxid: execMxid || d.exec_mxid,
    community_name: process.env.MEETING_PUBLISH_COMMUNITY_NAME || d.community_name,
    timezone: timezone || d.timezone,
    transcript_archive_url: `${String(siteUrl || d.site_url || "").replace(/\/+$/u, "")}/transcripts/${String(d.transcript_jurisdiction_slug || artifactsSlug)}`,
    transcript_jurisdiction_slug: String(d.transcript_jurisdiction_slug || artifactsSlug),
    ...extra,
  };
}
