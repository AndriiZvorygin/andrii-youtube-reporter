import fs from "node:fs";

const SCHEMA = "andrii-candidate-answer-coverage-v1";

function cleanName(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function key(value) {
  return cleanName(value).toLocaleLowerCase();
}

function candidateNames(candidates) {
  return [...new Set((Array.isArray(candidates) ? candidates : [])
    .map((candidate) => typeof candidate === "string" ? candidate : candidate?.canonical_name)
    .map(cleanName)
    .filter(Boolean))];
}

/**
 * Verify that the generated answer chapters cover the expected candidate
 * roster for every question window.  This is intentionally structural: it
 * checks model output against the canonical roster and transcript windows,
 * but never fabricates a missing answer or derives prose deterministically.
 */
export function buildCandidateAnswerCoverage({
  windows = [],
  answers = [],
  candidates = [],
  requireComplete = true,
} = {}) {
  const expected = candidateNames(candidates);
  const questions = (Array.isArray(windows) ? windows : [])
    .filter((window) => /^question_/iu.test(String(window?.question_id || "")))
    .map((window) => {
      const questionId = cleanName(window?.question_id);
      const questionAnswers = (Array.isArray(answers) ? answers : [])
        .filter((answer) => cleanName(answer?.question_id) === questionId);
      const counts = new Map();
      const invalid = [];
      for (const answer of questionAnswers) {
        const candidate = cleanName(answer?.candidate);
        const candidateKey = key(candidate);
        if (!expected.some((name) => key(name) === candidateKey)) {
          invalid.push({ candidate, id: cleanName(answer?.id) });
          continue;
        }
        counts.set(candidateKey, (counts.get(candidateKey) || 0) + 1);
        const start = Number(answer?.start_row);
        const end = Number(answer?.end_row);
        const windowStart = Number(window?.start_row);
        const windowEnd = Number(window?.end_row);
        if (!Number.isInteger(start) || !Number.isInteger(end)
          || end < start
          || (Number.isInteger(windowStart) && start < windowStart)
          || (Number.isInteger(windowEnd) && end > windowEnd)) {
          invalid.push({ candidate, id: cleanName(answer?.id), reason: "timeslot outside question window" });
        }
      }
      const supplied = expected.filter((name) => counts.has(key(name)));
      const missing = expected.filter((name) => !counts.has(key(name)));
      const duplicates = expected
        .filter((name) => Number(counts.get(key(name)) || 0) > 1)
        .map((name) => ({ candidate: name, count: counts.get(key(name)) }));
      return {
        question_id: questionId,
        title: cleanName(window?.title),
        start_row: Number(window?.start_row),
        end_row: Number(window?.end_row),
        expected_candidates: expected,
        supplied_candidates: supplied,
        missing_candidates: missing,
        duplicate_candidates: duplicates,
        invalid_answers: invalid,
        answer_count: questionAnswers.length,
        coverage_required: window?.coverage_required !== false,
        complete: missing.length === 0 && invalid.length === 0,
      };
    });

  const missingIssues = questions.flatMap((question) => question.missing_candidates.map((candidate) => ({
    question_id: question.question_id,
    title: question.title,
    candidate,
    issue: "missing candidate timeslot",
  }))).filter((issue) => questions.find((question) => question.question_id === issue.question_id)?.coverage_required !== false);
  const invalidIssues = questions.flatMap((question) => question.invalid_answers.map((answer) => ({
    question_id: question.question_id,
    title: question.title,
    ...answer,
    issue: answer.reason || "invalid answer timeslot",
  })));
  const required = Boolean(requireComplete) && expected.length >= 2 && questions.some((question) => question.coverage_required !== false);
  const issues = required ? [...missingIssues, ...invalidIssues] : invalidIssues;
  return {
    schema: SCHEMA,
    generated_at: new Date().toISOString(),
    required,
    expected_candidates: expected,
    question_count: questions.length,
    complete_question_count: questions.filter((question) => question.complete).length,
    pass: issues.length === 0,
    issues,
    questions,
  };
}

export function coverageReportPass(filePath) {
  try {
    const report = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return report?.schema === SCHEMA
      && report?.pass === true
      && Array.isArray(report?.expected_candidates)
      && Number(report?.question_count || 0) >= 1;
  } catch {
    return false;
  }
}

export { SCHEMA as CANDIDATE_ANSWER_COVERAGE_SCHEMA };
