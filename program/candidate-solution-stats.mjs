const COVERAGE_SCHEMA = "andrii-candidate-answer-coverage-v1";
const STATS_SCHEMA = "andrii-candidate-solution-stats-v5";
const MIN_RECURRING_QUESTION_COUNT = 2;

function clean(value) {
  return String(value || "").replace(/\s+/gu, " ").trim();
}

function key(value) {
  return clean(value).toLocaleLowerCase();
}

function markdownCell(value) {
  return clean(value).replace(/\|/gu, "\\|").replace(/\r?\n/gu, " ");
}

function parseJsonObject(text) {
  const raw = String(text || "").trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "")
    .replace(/<think>[\s\S]*?<\/think>/giu, "");
  try {
    const direct = JSON.parse(raw);
    return direct && typeof direct === "object" && !Array.isArray(direct) ? direct : null;
  } catch { /* scan below */ }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function groupedCandidateAnswers(answers, candidate) {
  const groups = new Map();
  for (const answer of Array.isArray(answers) ? answers : []) {
    if (key(answer?.candidate) !== key(candidate)) continue;
    const questionId = clean(answer?.question_id);
    const questionTitle = clean(answer?.question_title);
    const summary = clean(answer?.summary);
    if (!questionId || !summary) continue;
    const current = groups.get(questionId) || { question_id: questionId, question_title: questionTitle, summaries: [] };
    if (!current.summaries.includes(summary)) current.summaries.push(summary);
    groups.set(questionId, current);
  }
  return [...groups.values()];
}

function solutionStatsPrompt(candidate, groups) {
  return [
    `Candidate: ${candidate}`,
    "Identify the candidate's most recurring concrete policy proposals or solution themes in the verified answer summaries below.",
    "Group only substantively similar proposals; do not group merely related topics such as all housing or all taxes.",
    "Count distinct question IDs, not repeated follow-ups or repeated sentences within one answer.",
    "Return exactly JSON: {\"themes\":[{\"name\":string,\"question_ids\":[string],\"summary\":string}]}.",
    "Return up to three themes, but only include themes appearing in at least two distinct questions. If this candidate has no theme meeting that threshold, return an empty themes array.",
    "Keep each theme name to 2-8 words and name the concrete proposal, facility, project, or action, not a broad category. Preserve distinctive names and amounts when the candidate repeats them, such as a named water-storage facility.",
    "When a later answer uses a shorter or generic description of the same named proposal, facility, or project, group it with that named theme when the surrounding answer makes the connection clear.",
    "Rank themes by the number of distinct verified questions first. Keep concrete mechanisms separate from broad outcomes: do not let economic development or tourism replace a recurring mechanism such as development-charge incentives or fee forgiveness. If a mechanism recurs across several answers, include that mechanism as its own theme.",
    "Use the exact question IDs supplied. Each summary must be one neutral, source-faithful sentence describing what the candidate proposed or repeatedly emphasized; preserve proposal status and do not infer outcomes.",
    "Do not report another candidate's proposal, a moderator statement, a biographical detail, or a generic value such as leadership.",
    "QUESTION-SCOPED VERIFIED ANSWERS:",
    groups.map((group) => [
      `${group.question_id}: ${group.question_title}`,
      group.summaries.map((summary) => `- ${summary}`).join("\n"),
    ].join("\n")).join("\n\n"),
  ].join("\n\n");
}

function validateThemes(raw, candidate, groups) {
  const questionIds = new Set(groups.map((group) => group.question_id));
  const themes = Array.isArray(raw?.themes) ? raw.themes : [];
  const out = [];
  for (const theme of themes) {
    const name = clean(theme?.name);
    const summary = clean(theme?.summary);
    const ids = [...new Set((Array.isArray(theme?.question_ids) ? theme.question_ids : [])
      .map(clean).filter((id) => questionIds.has(id)))];
    if (!name || !summary || ids.length < MIN_RECURRING_QUESTION_COUNT) continue;
    if (summary.length < 25 || /(?:the transcript|the source|provided text|according to)/iu.test(summary)) continue;
    out.push({ candidate, name, summary, question_ids: ids, count: ids.length });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)).slice(0, 3);
}

export async function generateCandidateSolutionStats({ answers = [], coverage = {}, askModel } = {}) {
  if (coverage?.schema !== COVERAGE_SCHEMA || coverage?.pass !== true || typeof askModel !== "function") return null;
  const candidates = Array.isArray(coverage.expected_candidates)
    ? coverage.expected_candidates.map(clean).filter(Boolean)
    : [];
  if (candidates.length < 2 || !Array.isArray(answers)) return null;
  const output = [];
  for (const candidate of candidates) {
    const groups = groupedCandidateAnswers(answers, candidate);
    if (!groups.length) throw new Error(`candidate solution stats missing verified answers for ${candidate}`);
    const response = await askModel({
      system: "You identify recurring policy proposals in verified civic debate answers. Return JSON only.",
      prompt: solutionStatsPrompt(candidate, groups),
      maxTokens: 850,
      temperature: 0.1,
      format: {
        type: "object",
        properties: {
          themes: {
            type: "array",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                question_ids: { type: "array", items: { type: "string" } },
                summary: { type: "string" },
              },
              required: ["name", "question_ids", "summary"],
            },
          },
        },
        required: ["themes"],
      },
    });
    const themes = validateThemes(parseJsonObject(response), candidate, groups);
    output.push({ candidate, themes });
  }
  return {
    schema: STATS_SCHEMA,
    coverage_schema: COVERAGE_SCHEMA,
    generated_at: new Date().toISOString(),
    candidates: output,
  };
}

export function renderCandidateSolutionStats(stats) {
  if (stats?.schema !== STATS_SCHEMA || !Array.isArray(stats?.candidates) || !stats.candidates.length) return "";
  const bullets = [];
  for (const entry of stats.candidates) {
    const candidate = clean(entry?.candidate);
    const themes = Array.isArray(entry?.themes) ? entry.themes : [];
    if (!candidate || !themes.length) continue;
    const fragments = [];
    for (const theme of themes) {
      const name = clean(theme?.name);
      const summary = clean(theme?.summary);
      const count = Number(theme?.count || theme?.question_ids?.length || 0);
      if (!name || !summary || !Number.isInteger(count) || count < MIN_RECURRING_QUESTION_COUNT) continue;
      const label = `${count} distinct question${count === 1 ? "" : "s"}`;
      fragments.push(`${markdownCell(name)} (${label})`);
    }
    if (fragments.length) bullets.push(`- **${markdownCell(candidate)}:** ${fragments.join("; ")}.`);
  }
  if (!bullets.length) return "";
  return [
    "## Most Newsworthy Items",
    "",
    "Recurring solutions below are counted by distinct verified questions; repeated follow-ups within one question count once.",
    "",
    ...bullets,
  ].join("\n");
}

export { COVERAGE_SCHEMA as CANDIDATE_SOLUTION_COVERAGE_SCHEMA, STATS_SCHEMA as CANDIDATE_SOLUTION_STATS_SCHEMA };
