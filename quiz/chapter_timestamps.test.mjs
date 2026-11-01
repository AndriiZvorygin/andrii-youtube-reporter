import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  chapterTextStartsAtZero,
  formatChapterTimestamp,
  normalizeChapterText,
  normalizeChapterTextFile,
  parseChapterTimestamp,
} from "../program/chapter-timestamps.mjs";
import { isSparseChapterUnit } from "../program/summarize-chapter-grounding-from-transcript-folder.mjs";

test("YouTube chapter timestamps parse both minute and hour forms", () => {
  assert.equal(parseChapterTimestamp("00:00"), 0);
  assert.equal(parseChapterTimestamp("01:15"), 75);
  assert.equal(parseChapterTimestamp("01:02:03"), 3723);
  assert.equal(parseChapterTimestamp("01:60"), null);
});

test("the first chapter is rendered as the required 00:00 marker", () => {
  assert.equal(formatChapterTimestamp(0, { first: true }), "00:00");
  assert.equal(formatChapterTimestamp(15), "00:00:15");
  assert.equal(formatChapterTimestamp(3723), "01:02:03");
});

test("legacy non-zero opening markers are normalized without changing later chapters", () => {
  const input = "00:00:15 Opening\n00:06:00 Topic\n";
  const output = normalizeChapterText(input);
  assert.equal(output, "00:00 Opening\n00:06:00 Topic\n");
  assert.equal(chapterTextStartsAtZero(output), true);
  assert.equal(normalizeChapterText(output), output);
});

test("chapter checkpoint migration rewrites only when needed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "andrii-chapters-"));
  const file = path.join(dir, "chapters.txt");
  fs.writeFileSync(file, "00:00:01 Intro\n00:01:00 Topic\n", "utf8");
  assert.equal(normalizeChapterTextFile(file), true);
  assert.equal(fs.readFileSync(file, "utf8"), "00:00 Intro\n00:01:00 Topic\n");
  assert.equal(normalizeChapterTextFile(file), false);
});

test("sparse procedural chapter windows do not require topic adjudication", () => {
  assert.equal(isSparseChapterUnit({ sourceRows: 1, sourceExcerpt: "SPEAKER_062: No." }), true);
  assert.equal(isSparseChapterUnit({
    sourceRows: 16,
    sourceExcerpt: "SPEAKER_062: The board reviewed quarterly collision reports and discussed next steps.",
  }), false);
});
