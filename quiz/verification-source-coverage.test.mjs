import assert from "node:assert/strict";
import test from "node:test";

import { verificationSourceCoverage } from "../program/run-andrii-youtube-meeting-from-ref.mjs";

test("whole-stream verification keeps complete moderate-length transcripts", () => {
  const source = `${"opening source text ".repeat(2500)} exact late chronology evidence: all 78 missing person occurrences were located. ${"closing source text ".repeat(500)}`;
  assert.ok(source.length > 40_000);
  assert.equal(verificationSourceCoverage(source), source.trim());
});
