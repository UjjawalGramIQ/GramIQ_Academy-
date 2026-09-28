/**
 * Pure text-flattening helper used to ground the Gemini quiz-option
 * generator in a module's actual content. Kept dependency-free (only
 * imports the `Block` type) so it can be unit-tested under plain Node
 * without pulling in lib/gemini/client's extensionless internal imports,
 * which only resolve under tsx or Next's bundler.
 */
import type { Block } from "./blocks";

function runsToPlainText(runs: { t: string }[]): string {
  return runs.map((r) => r.t).join("");
}

/** Flattens a module's section/intro/outro blocks into grounding text for the generator — headings and paragraphs only, tables/images skipped as low signal-to-noise for MCQ distractor generation. */
export function buildGroundingText(blocks: Block[], maxChars = 6000): string {
  const lines: string[] = [];
  for (const block of blocks) {
    if (block.type === "heading") lines.push(`## ${runsToPlainText(block.runs)}`);
    else if (block.type === "paragraph") lines.push(runsToPlainText(block.runs));
    else if (block.type === "list") {
      for (const item of block.items) lines.push(`- ${runsToPlainText(item.runs)}`);
    } else if (block.type === "card") {
      lines.push(buildGroundingText(block.blocks, maxChars));
    }
  }
  const text = lines.filter(Boolean).join("\n");
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}
