import assert from "node:assert/strict";
import test from "node:test";
import {
  generateCandidateSolutionStats,
  renderCandidateSolutionStats,
} from "../program/candidate-solution-stats.mjs";

const coverage = {
  schema: "andrii-candidate-answer-coverage-v1",
  pass: true,
  expected_candidates: ["Richard Thomas", "Ray Botten"],
};

const answers = [
  {
    candidate: "Richard Thomas",
    question_id: "question_04",
    question_title: "How should the city grow?",
    summary: "He supports growth and forgiving development charges for projects that advance housing.",
  },
  {
    candidate: "Richard Thomas",
    question_id: "question_05",
    question_title: "How would you lower taxes?",
    summary: "He again emphasizes growth and development-charge forgiveness as part of his approach.",
  },
  {
    candidate: "Richard Thomas",
    question_id: "question_05",
    question_title: "How would you lower taxes?",
    summary: "He again emphasizes growth and development-charge forgiveness as part of his approach.",
  },
  {
    candidate: "Ray Botten",
    question_id: "question_05",
    question_title: "How would you lower taxes?",
    summary: "He proposes a nine-billion-dollar water-storage facility as an economic opportunity.",
  },
  {
    candidate: "Ray Botten",
    question_id: "question_08",
    question_title: "What infrastructure is needed?",
    summary: "He returns to the proposed nine-billion-dollar water-storage facility.",
  },
];

test("candidate solution stats count distinct verified questions", async () => {
  const prompts = [];
  const stats = await generateCandidateSolutionStats({
    answers,
    coverage,
    askModel: async ({ prompt }) => {
      prompts.push(prompt);
      if (prompt.includes("Candidate: Richard Thomas")) {
        return JSON.stringify({
          themes: [{
            name: "Growth and development-charge forgiveness",
            question_ids: ["question_04", "question_05", "question_05"],
            summary: "He repeatedly proposes growth paired with forgiving development charges for qualifying projects.",
          }],
        });
      }
      return JSON.stringify({
        themes: [{
          name: "Nine-billion-dollar water-storage facility",
          question_ids: ["question_05", "question_08"],
          summary: "He repeatedly points to a proposed nine-billion-dollar water-storage facility as an opportunity.",
        }],
      });
    },
  });

  assert.equal(prompts.length, 2);
  assert.equal(stats.candidates[0].themes[0].count, 2);
  assert.equal(stats.candidates[1].themes[0].count, 2);
  const markdown = renderCandidateSolutionStats(stats);
  assert.match(markdown, /## Most Newsworthy Items/u);
  assert.match(markdown, /\*\*Richard Thomas:\*\* Growth and development-charge forgiveness \(2 distinct questions\)/u);
  assert.match(markdown, /\*\*Ray Botten:\*\* Nine-billion-dollar water-storage facility \(2 distinct questions\)/u);
  assert.doesNotMatch(markdown, /He repeatedly proposes/u);
});

test("solution stats are omitted without a complete verified coverage report", async () => {
  assert.equal(await generateCandidateSolutionStats({ answers, coverage: { ...coverage, pass: false }, askModel: async () => "{}" }), null);
  assert.equal(renderCandidateSolutionStats({ schema: "andrii-candidate-solution-stats-v5", candidates: [] }), "");
});

test("one-question themes are excluded from recurring solutions", async () => {
  const stats = await generateCandidateSolutionStats({
    answers,
    coverage,
    askModel: async ({ prompt }) => prompt.includes("Candidate: Richard Thomas")
      ? JSON.stringify({ themes: [{
        name: "One-question proposal",
        question_ids: ["question_04"],
        summary: "A proposal mentioned in only one verified question.",
      }] })
      : JSON.stringify({ themes: [{
        name: "Nine-billion-dollar water-storage facility",
        question_ids: ["question_05", "question_08"],
        summary: "He repeatedly points to a proposed nine-billion-dollar water-storage facility as an opportunity.",
      }] }),
  });
  assert.deepEqual(stats.candidates[0].themes, []);
  const markdown = renderCandidateSolutionStats(stats);
  assert.doesNotMatch(markdown, /One-question proposal/u);
  assert.match(markdown, /Nine-billion-dollar water-storage facility \(2 distinct questions\)/u);
});
