import type { Block, Run } from "./blocks";

/**
 * ponytail: O(n) text extraction over runs — fast and accurate enough for educational modules.
 * Assumes an average reading speed of ~180 words per minute across bilingual Hindi/Marathi/English text.
 */
function extractRunsText(runs?: Run[]): string {
  if (!runs || !Array.isArray(runs)) return "";
  return runs.map((r) => r.t || "").join(" ");
}

function countWords(text: string): number {
  if (!text) return 0;
  const tokens = text.trim().split(/\s+/);
  return tokens.filter(Boolean).length;
}

export function estimateReadingMinutes(blocks?: Block[]): number {
  if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
    return 1;
  }

  let totalWords = 0;

  for (const block of blocks) {
    if (!block) continue;
    switch (block.type) {
      case "heading":
      case "paragraph":
        totalWords += countWords(extractRunsText(block.runs));
        break;

      case "list":
        for (const item of block.items || []) {
          totalWords += countWords(extractRunsText(item.runs));
        }
        break;

      case "table":
        if (block.head) {
          for (const cell of block.head) {
            totalWords += countWords(extractRunsText(cell));
          }
        }
        if (block.rows) {
          for (const row of block.rows) {
            for (const cell of row) {
              totalWords += countWords(extractRunsText(cell));
            }
          }
        }
        break;

      case "image":
        // Images contribute about ~10 seconds of visual processing (~30 word equivalent)
        totalWords += 30;
        break;

      case "card":
        totalWords += estimateReadingMinutes(block.blocks) * 180;
        break;
    }
  }

  // 180 words per minute reading speed; round up, min 1 minute
  return Math.max(1, Math.ceil(totalWords / 180));
}

export function formatReadingTime(minutes: number, lang: "mr" | "en" = "mr"): string {
  const safeMins = Math.max(1, Math.round(minutes));
  if (lang === "mr") {
    return `~${safeMins} मि. वाचन`;
  }
  return `~${safeMins} min read`;
}
