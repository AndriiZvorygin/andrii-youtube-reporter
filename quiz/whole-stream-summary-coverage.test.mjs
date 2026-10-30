import test from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TEXT_MODEL } from "../../../../program/runtime/gpu/text-model.mjs";

import {
  parseSummaryCoverageChunks,
  verifyStreamSummaryLlm,
} from "../program/run-andrii-youtube-meeting-from-ref.mjs";

function pyaCoverageLine(chunkId, chapterTitles, chunkSummary, start, end) {
  const payload = JSON.stringify({
    "chunk id": chunkId,
    "chapter start index": start,
    "chapter end index": end,
    "source section count": end - start + 1,
    "source byte count": 1000,
    "chapter titles": chapterTitles,
    "chunk summary text": chunkSummary,
  }).replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
  return `su name meeting summary chunk ${chunkId} since num ${start}.000 until num ${end}.000 ob text "${payload}" ya`;
}

test("Andrii whole-stream verifier retries a repair that omits a late chronology chunk", async (t) => {
  const coverageText = [
    pyaCoverageLine(
      "meeting_chunk_001",
      ["Solar Body identity", "Parent-child dynamics", "Cats and higher energies"],
      "The discussion covers the Solar Body, parent-child dynamics, and cats sensing higher energies.",
      0,
      2,
    ),
    pyaCoverageLine(
      "meeting_chunk_002",
      ["Soul fragmentation", "NDE memory retention", "Pre-incarnative planning"],
      "The discussion covers soul fragmentation, retaining NDE memories, and pre-incarnative planning.",
      3,
      5,
    ),
  ].join("\n");
  assert.equal(parseSummaryCoverageChunks(coverageText).length, 2);

  const sourceText = [
    "The Solar Body has an identity.",
    "The speakers discuss parent-child dynamics and cats sensing higher energies.",
    "They discuss soul fragmentation and NDE memory retention.",
    "They suggest pre-incarnative planning for channeling.",
  ].join(" ");
  const missingLateChunk = [
    "## Whole Stream Summary",
    "The discussion examines the Solar Body identity. Parent-child dynamics are discussed as spiritual relationships. Cats are described as sensing higher energies. The group compares different spiritual perspectives. Speakers return to the role of personal experience. The conversation remains focused on the opening themes.",
    "",
    "## Most Newsworthy Items",
    "* The Solar Body identity is discussed.",
    "* Parent-child dynamics are examined.",
    "* Cats are described as sensing higher energies.",
    "* The group compares spiritual perspectives.",
    "* Personal experience is discussed.",
    "* The opening themes are revisited.",
  ].join("\n");
  const complete = [
    "## Whole Stream Summary",
    "The discussion examines the Solar Body identity. Parent-child dynamics are discussed as spiritual relationships. Cats are described as sensing higher energies. Speakers explore soul fragmentation during incarnation. They discuss practices associated with retaining NDE memories. The group suggests that channeling experiences may involve pre-incarnative planning.",
    "",
    "## Most Newsworthy Items",
    "* The Solar Body identity is discussed.",
    "* Parent-child dynamics are examined.",
    "* Cats are described as sensing higher energies.",
    "* Soul fragmentation during incarnation is explored.",
    "* NDE memory retention practices are discussed.",
    "* Pre-incarnative planning for channeling is suggested.",
  ].join("\n");

  const originalFetch = globalThis.fetch;
  const prompts = [];
  let verifierCalls = 0;
  let auditCalls = 0;
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(String(options?.body || "{}"));
    assert.equal(body.model, DEFAULT_TEXT_MODEL);
    const prompt = String(body?.messages?.[1]?.content || "");
    prompts.push(prompt);
    let content;
    if (prompt.includes("Validate and correct this livestream summary against the transcript source.")) {
      verifierCalls += 1;
      content = JSON.stringify({
        pass: verifierCalls > 1,
        corrected_markdown: verifierCalls > 1 ? complete : missingLateChunk,
        issues: verifierCalls === 1 ? ["remove unsupported anecdote"] : [],
      });
    } else if (prompt.includes("Check whether the WHOLE STREAM SUMMARY paragraph covers this chronology chunk.")) {
      auditCalls += 1;
      const lateChunkOmitted = auditCalls === 2;
      content = JSON.stringify({
        covered: !lateChunkOmitted,
        evidence: lateChunkOmitted ? "" : "a concrete topic appears in the paragraph",
        missing_topics: lateChunkOmitted ? ["Soul fragmentation", "NDE memory retention", "Pre-incarnative planning"] : [],
      });
    } else {
      throw new Error(`unexpected qwen prompt: ${prompt.slice(0, 120)}`);
    }
    return { ok: true, async json() { return { message: { content } }; } };
  };
  t.after(() => { globalThis.fetch = originalFetch; });

  const result = await verifyStreamSummaryLlm({
    candidate: complete,
    sourceText,
    coverageText,
    focus: "neutral source-faithful coverage",
    context: "Channeling discussion",
  });

  assert.equal(result.pass, true);
  assert.equal(result.attempts, 2);
  assert.equal(verifierCalls, 2);
  assert.equal(auditCalls, 4);
  assert.match(prompts[3], /chronology coverage audit/u);
  assert.match(prompts[3], /meeting_chunk_002/u);
});
