export const DEFAULT_SUMMARY_FOCUS = "the main topics and concrete claims discussed in the stream, using a neutral source-faithful lens";

// Focus is an instruction to the summarizer, not a licence to apply an
// ideology that is absent from the recording.  Older run configurations used
// a distributist framing; treat that legacy value as stale and replace it at
// the pipeline boundary so it cannot keep steering chapter or whole-stream
// summaries after a retry.
export function normalizeSummaryFocus(value) {
  const raw = String(value || "").replace(/\s+/gu, " ").trim();
  if (!raw || /\bdistribut(?:ist|ism)\b/iu.test(raw)) return DEFAULT_SUMMARY_FOCUS;
  return raw;
}
