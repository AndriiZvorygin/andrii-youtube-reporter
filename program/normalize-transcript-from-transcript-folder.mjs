#!/usr/bin/env node
import { runNormalizeShared } from "../../../../command/normalize_transcript_from_transcript_folder_shared.mjs";

runNormalizeShared("andrii", process.argv.slice(2)).catch((err) => {
  process.stderr.write(`${String(err?.stack || err?.message || err)}\n`);
  process.exit(1);
});
