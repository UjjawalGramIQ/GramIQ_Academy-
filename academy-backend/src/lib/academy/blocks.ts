/**
 * GramIQ Academy v5 — persisted content block schema.
 *
 * Produced by `lib/academy/docx-parser.ts` from a single-module docx
 * (see `scripts/academy/split-course-docx.mjs` for how a module docx is
 * derived from the master course document), and consumed by the reader's
 * BlockRenderer (Phase 6).
 *
 * Deliberately diverges from `labs/academy/app-v4/src/content/types.ts`:
 *  - No `LocalizedString` per field — language lives one level up as a
 *    parallel DB row (`academy.section_content.lang`), because the input
 *    is two independently parsed docx, not hand-typed bilingual content.
 *  - `text: string` becomes `runs: Run[]` — requirement 8 (render exactly
 *    as authored: bold/color/size) needs run-level fidelity that a plain
 *    string cannot carry.
 *  - No `callout` / `formula` / `definition` blocks — nothing in OOXML
 *    lets a parser derive those; emitting them would be inventing
 *    structure the author never expressed.
 */

export type Align = "left" | "center" | "right" | "justify";

export interface InlineStyle {
  b?: true;
  i?: true;
  u?: true;
  s?: true; // strikethrough
  sup?: true;
  sub?: true;
  /** Hex, e.g. "#1f4e79". w:val="auto" is dropped so dark mode still works. */
  color?: string;
  /** Hex background — from w:highlight (named color) or w:shd/@w:fill. */
  bg?: string;
  /** RATIO to the document's default run size (w:docDefaults), e.g. 1.27. Never px/pt. */
  sz?: number;
  /** Only set when it differs from the document default font. */
  font?: string;
}

export interface Run {
  t: string;
  s?: InlineStyle;
  href?: string;
}

export interface TableSpan {
  r: number;
  c: number;
  colSpan?: number;
  /** true when this cell is covered by a vertical merge continuation (w:vMerge without w:val="restart"). */
  rowSpanContinuation?: true;
}

export type Block =
  | { type: "heading"; level: 3; runs: Run[]; align?: Align }
  | { type: "paragraph"; runs: Run[]; align?: Align; indent?: number }
  | { type: "list"; ordered: boolean; items: { runs: Run[]; level: number }[] }
  | {
      type: "table";
      head?: Run[][];
      rows: Run[][][];
      widths?: number[]; // percent of row total, sums to ~100
      spans?: TableSpan[];
    }
  /** A single-grid-column table unwrapped into its own mini layout — see docx-parser's "infographic container" rule. */
  | { type: "card"; blocks: Block[] }
  | { type: "image"; url: string; alt?: string; widthPx?: number; heightPx?: number }
  | { type: "divider" };

export type WarningCode =
  | "HEADING_DEMOTED"
  | "LEAD_CONTENT"
  | "FOOTNOTE_DROPPED"
  | "ENDNOTE_DROPPED"
  | "COMMENT_DROPPED"
  | "HYPERLINK_INTERNAL_FLATTENED"
  | "IMAGE_MISSING_RELATIONSHIP";

export interface ParseWarning {
  code: WarningCode;
  message: string;
  /** 0-based index of the offending paragraph within the module docx, for admin UI display. */
  paragraphIndex?: number;
  excerpt?: string;
}

export interface ParsedSection {
  /** e.g. "2.1" — taken directly from the document's own numbering. */
  displayNo: string;
  /** The section heading with the display number stripped, e.g. "What is opportunity cost?" */
  title: string;
  titleRuns: Run[];
  blocks: Block[];
}

export interface ParsedReviewQuestion {
  /** 1, 2 or 3 — position within the module's Review Questions block. */
  position: number;
  prompt: string;
}

/**
 * A content-addressed placeholder for an embedded image, produced by the
 * parser (which never touches the network — Phase 1 is a pure library).
 * A later phase (the admin upload handler) uploads `bytes` to Supabase
 * Storage and rewrites every `image` block whose `url` equals this key to
 * the real public URL.
 */
export interface ParsedMedia {
  /** Placeholder scheme: `docx-media:<sha256-16>.<ext>` — matches the final Supabase path's leaf. */
  placeholder: string;
  bytes: Buffer;
  contentType: string;
  ext: string;
}

export interface ParsedModule {
  /** e.g. "Module 2 — Opportunity Cost in Farming" (module 0's synthetic title for front matter). */
  title: string;
  titleRuns: Run[];
  /** Content before the first numbered section (e.g. "Learning Objectives", "Introduction"). */
  introBlocks: Block[];
  sections: ParsedSection[];
  /** Content after the last numbered section (Key Concepts / Key Takeaways / Module Summary). */
  outroBlocks: Block[];
  reviewQuestions: ParsedReviewQuestion[];
  media: ParsedMedia[];
  warnings: ParseWarning[];
  errors: ParseError[];
}

export type ErrorCode =
  | "MODULE_MULTIPLE_H1"
  | "MODULE_NO_H1"
  | "REVIEW_QUESTIONS_MISSING"
  | "REVIEW_QUESTIONS_COUNT"
  | "REVIEW_QUESTION_TEXT_EMPTY";

export interface ParseError {
  code: ErrorCode;
  message: string;
  paragraphIndex?: number;
  excerpt?: string;
}
