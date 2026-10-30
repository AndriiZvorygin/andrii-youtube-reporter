import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { buildCandidateAnswerCoverage } from "../program/candidate-answer-coverage.mjs";

const candidates = ["Ray Botten", "Jodi King", "Carol Merton"];
const windows = [{ question_id: "question_01", title: "Qualifications", start_row: 10, end_row: 30 }];

test("candidate answer coverage passes when every candidate has a bounded timeslot", () => {
  const report = buildCandidateAnswerCoverage({
    windows,
    candidates,
    answers: candidates.map((candidate, index) => ({
      id: `a${index}`,
      question_id: "question_01",
      candidate,
      start_row: 12 + index * 5,
      end_row: 14 + index * 5,
    })),
  });
  assert.equal(report.required, true);
  assert.equal(report.pass, true);
  assert.deepEqual(report.questions[0].missing_candidates, []);
});

test("candidate answer coverage fails and identifies missing candidates", () => {
  const report = buildCandidateAnswerCoverage({
    windows,
    candidates,
    answers: [{
      id: "a1",
      question_id: "question_01",
      candidate: "Ray Botten",
      start_row: 12,
      end_row: 14,
    }],
  });
  assert.equal(report.pass, false);
  assert.deepEqual(report.questions[0].missing_candidates, ["Jodi King", "Carol Merton"]);
  assert.equal(report.issues.length, 2);
});

test("coverage can be explicitly relaxed for a partial-format panel", () => {
  const report = buildCandidateAnswerCoverage({
    windows,
    candidates,
    requireComplete: false,
    answers: [{
      id: "a1",
      question_id: "question_01",
      candidate: "Ray Botten",
      start_row: 12,
      end_row: 14,
    }],
  });
  assert.equal(report.required, false);
  assert.equal(report.pass, true);
  assert.deepEqual(report.questions[0].missing_candidates, ["Jodi King", "Carol Merton"]);
});

test("audience-style question windows remain visible without blocking a full-round gate", () => {
  const report = buildCandidateAnswerCoverage({
    windows: [{ ...windows[0], coverage_required: false }],
    candidates,
    answers: [{ question_id: "question_01", candidate: "Ray Botten", start_row: 12, end_row: 14 }],
  });
  assert.equal(report.required, false);
  assert.equal(report.pass, true);
  assert.deepEqual(report.questions[0].missing_candidates, ["Jodi King", "Carol Merton"]);
});

test("pipeline checkpoints require the coverage artifact", () => {
  const meetingRunner = fs.readFileSync(new URL("../program/run-andrii-youtube-meeting-from-ref.mjs", import.meta.url), "utf8");
  const fullPipeline = fs.readFileSync(new URL("../program/run-full-transcript-pipeline.mjs", import.meta.url), "utf8");
  assert.match(meetingRunner, /coverageReportPass\(coveragePath\)/u);
  assert.match(fullPipeline, /coverageReportPass\(artifacts\.candidateAnswerCoverage\)/u);
});
