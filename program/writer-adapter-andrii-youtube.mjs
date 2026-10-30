import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_SUMMARY_FOCUS } from "./defaults.mjs";
import { defineWriterAdapter } from "./shared-writer-adapter-interface.mjs";

const PROGRAM_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOUSE_ROOT = path.resolve(PROGRAM_DIR, "..");

export const ANDRII_ADAPTER = defineWriterAdapter({
  writer_id: "andrii-youtube-reporter",
  source_id: "youtube-live",
  house_root: HOUSE_ROOT,
  artifacts_slug: "andrii-youtube",
  refresh_calendar_cmd: ["node", path.join(PROGRAM_DIR, "extract-andrii-youtube-streams-monthly.mjs")],
  run_meeting_from_ref_cmd: ["node", path.join(PROGRAM_DIR, "run-andrii-youtube-meeting-from-ref.mjs")],
  send_dm_cmd: ["node", path.join(PROGRAM_DIR, "send-executive-dm.mjs")],
  identity: {
    jurisdiction: "Andrii Zvorygin",
    default_body: "Livestream",
    community_name: "andrii-zvorygin",
  },
  publish: {
    community_name: "andrii-zvorygin",
    command_env_order: ["ANDRII_LEMMY_POST_COMMAND", "MEETING_POST_COMMAND"],
  },
  defaults: {
    base_prefix: "meeting-qwen-auto",
    focus: DEFAULT_SUMMARY_FOCUS,
    jurisdiction: "Andrii Zvorygin",
    body: "Livestream",
    site_url: "https://andrii.zvorygin.ca",
    discussion_url: "",
    exec_mxid: "@operator:example.invalid",
    community_name: "andrii-zvorygin",
    timezone: "America/Toronto",
    transcript_jurisdiction_slug: "andrii-zvorygin-ca",
    source_channel_url: "https://www.youtube.com/@AndriiZ/streams",
  },
});
