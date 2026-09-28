/**
 * JSON extraction from a Gemini text response. Fresh replacement for the
 * missing original lib/gemini/gemini-executor.ts — see client.ts's header.
 * Even with responseMimeType: "application/json", models occasionally wrap
 * output in a markdown code fence, so both are handled.
 */
export function extractJSON(rawText: string): unknown {
  const trimmed = rawText.trim();

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fenced ? fenced[1]! : trimmed;

  try {
    return JSON.parse(candidate);
  } catch {
    // Fall back to the first {...} or [...] span in case of leading/trailing prose.
    const objectMatch = candidate.match(/\{[\s\S]*\}/);
    const arrayMatch = candidate.match(/\[[\s\S]*\]/);
    const span = objectMatch?.[0] ?? arrayMatch?.[0];
    if (span) {
      try {
        return JSON.parse(span);
      } catch {
        // fall through
      }
    }
    throw new Error("Could not extract valid JSON from model response.");
  }
}
