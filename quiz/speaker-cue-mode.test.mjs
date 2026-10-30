import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const readProgram = (name) => fs.readFileSync(new URL(`../program/${name}`, import.meta.url), "utf8");
const readMain = (name) => fs.readFileSync(new URL(`../../../../${name}`, import.meta.url), "utf8");

test("Andrii transcript wrappers enable sentence-level cue diarization", () => {
  const runner = readProgram("run-andrii-youtube-meeting-from-ref.mjs");
  const folderRunner = readProgram("run-full-transcript-pipeline-from-meeting-folder.mjs");
  const pipeline = readProgram("run-full-transcript-pipeline.mjs");
  assert.match(runner, /PYA_SPEAKER_TWO_SPEAKER_CUE_TURNS:/u);
  assert.match(folderRunner, /PYA_SPEAKER_TWO_SPEAKER_CUE_TURNS:/u);
  assert.match(pipeline, /PYA_SPEAKER_TWO_SPEAKER_CUE_TURNS:/u);
  assert.match(pipeline, /PYA_SPEAKER_CUE_LEVEL_TURNS:/u);
  assert.match(runner, /looksLikeInterview\(/u);
  assert.match(folderRunner, /looksLikeInterview\(/u);
});

test("Andrii panel handoffs repair gaps and preserve moderator controls", () => {
  const linker = readProgram("link-panel-speakers-from-transcript-folder.mjs");
  const segmenter = readProgram("segment-candidate-answers-from-transcript-folder.mjs");
  const renderer = readMain("command/render_transcript_html_from_transcript_folder.mjs");
  assert.match(linker, /function repairHandoffGaps\(spans, rows\)/u);
  assert.match(linker, /Explicit moderator handoff names this candidate/u);
  assert.ok(linker.includes("go\\s+ahead"));
  assert.ok(linker.includes("take\\s+(?:our\\s+)?(?:first\\s+)?break"));
  assert.match(linker, /you are listening to/u);
  assert.match(linker, /firstNameCount/u);
  assert.match(segmenter, /firstNames/u);
  assert.doesNotMatch(renderer, /span\?\.role === "moderator" && cue\.test\([^)]*\)\) continue/u);
});
