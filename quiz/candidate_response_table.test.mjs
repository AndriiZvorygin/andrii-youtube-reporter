import assert from "node:assert/strict";
import test from "node:test";
import { buildCandidateResponseTable } from "../program/candidate-response-table.mjs";

const coverage = {
  schema: "andrii-candidate-answer-coverage-v1",
  pass: true,
  expected_candidates: ["Ray Botten", "Jodi King"],
  questions: [{ question_id: "question_01", title: "Why are you running for mayor" }],
};

test("candidate response table groups verified answer summaries by question and candidate", () => {
  const markdown = buildCandidateResponseTable({
    coverage,
    answers: [
      { question_id: "question_01", candidate: "Ray Botten", summary: "Addresses the drug pandemic." },
      { question_id: "question_01", candidate: "Jodi King", summary: "Wants to unite the community." },
      { question_id: "question_01", candidate: "Jodi King", summary: "Emphasizes listening." },
    ],
  });
  assert.match(markdown, /## Candidate Response Comparison/u);
  assert.match(markdown, /\| Ray Botten \| Addresses the drug pandemic\. \|/u);
  assert.match(markdown, /\| Jodi King \| Wants to unite the community\. Emphasizes listening\. \|/u);
});

test("comparison is omitted unless coverage is complete and every cell has a summary", () => {
  assert.equal(buildCandidateResponseTable({ coverage: { ...coverage, pass: false }, answers: [] }), "");
  assert.equal(buildCandidateResponseTable({ coverage, answers: [{ question_id: "question_01", candidate: "Ray Botten", summary: "Only one answer." }] }), "");
});

test("markdown pipes in generated summaries are escaped without rewriting the prose", () => {
  const markdown = buildCandidateResponseTable({
    coverage,
    answers: [
      { question_id: "question_01", candidate: "Ray Botten", summary: "Compares transit | roads." },
      { question_id: "question_01", candidate: "Jodi King", summary: "Listens to residents." },
    ],
  });
  assert.match(markdown, /Compares transit \\\| roads\./u);
});
