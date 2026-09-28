/**
 * GramIQ Academy v5 — docx -> ParsedModule.
 *
 * Parses a single-module docx (as produced by
 * `scripts/academy/split-course-docx.mjs`) into the typed block model in
 * `blocks.ts`. Pure library: no database, no network, no Supabase upload —
 * embedded images are returned as content-addressed placeholders (see
 * `ParsedMedia`) for a later phase to upload and rewrite.
 *
 * Library choice: jszip + fast-xml-parser, not mammoth. Mammoth's design
 * goal is to discard run-level color/size/highlight in favour of "clean
 * semantic HTML" — the opposite of requirement 8 (render exactly as
 * authored). Direct OOXML parsing also yields a typed block model instead
 * of an HTML string, which keeps `dangerouslySetInnerHTML` out of an
 * admin-upload code path entirely.
 */
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { createHash } from "node:crypto";
import type {
  Align,
  Block,
  InlineStyle,
  ParseError,
  ParsedMedia,
  ParsedModule,
  ParsedReviewQuestion,
  ParsedSection,
  ParseWarning,
  Run,
} from "./blocks.ts";
import {
  attr,
  childrenOf,
  findChild,
  findChildren,
  findDescendant,
  tagOf,
  textOf,
  type XmlChildren,
  type XmlNode,
} from "./ooxml.ts";

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  trimValues: false,
});

// ---------------------------------------------------------------------------
// The 17 named WordprocessingML highlight colors (w:highlight/@w:val -> hex).
// ---------------------------------------------------------------------------
const HIGHLIGHT_HEX: Record<string, string> = {
  yellow: "#ffff00",
  green: "#00ff00",
  cyan: "#00ffff",
  magenta: "#ff00ff",
  blue: "#0000ff",
  red: "#ff0000",
  darkBlue: "#00008b",
  darkCyan: "#008b8b",
  darkGreen: "#006400",
  darkMagenta: "#8b008b",
  darkRed: "#8b0000",
  darkYellow: "#808000",
  darkGray: "#a9a9a9",
  lightGray: "#d3d3d3",
  black: "#000000",
  white: "#ffffff",
  none: "",
};

// ---------------------------------------------------------------------------
// Zip / relationships / styles loading
// ---------------------------------------------------------------------------

interface DocxParts {
  documentBody: XmlChildren;
  stylesTree: XmlChildren;
  numberingTree: XmlChildren;
  rels: Map<string, string>; // r:id -> Target
  mediaBytes: Map<string, Buffer>; // "media/imageN.png" -> bytes
}

async function readEntryString(zip: JSZip, name: string): Promise<string | null> {
  const f = zip.file(name);
  if (!f) return null;
  return f.async("string");
}

async function readEntryBuffer(zip: JSZip, name: string): Promise<Buffer | null> {
  const f = zip.file(name);
  if (!f) return null;
  return f.async("nodebuffer");
}

async function loadDocxParts(docxBuffer: Buffer): Promise<DocxParts> {
  const zip = await JSZip.loadAsync(docxBuffer);

  const documentXml = await readEntryString(zip, "word/document.xml");
  if (!documentXml) throw new Error("word/document.xml missing — not a valid docx");
  const documentTree = xmlParser.parse(documentXml) as XmlChildren;
  const documentRoot = findDescendant(documentTree, "w:document");
  const body = documentRoot ? findChild(childrenOf(documentRoot), "w:body") : undefined;
  const documentBody = body ? childrenOf(body) : [];
  const stylesXml = await readEntryString(zip, "word/styles.xml");
  const stylesRoot = stylesXml ? findDescendant(xmlParser.parse(stylesXml) as XmlChildren, "w:styles") : undefined;
  const stylesTree = stylesRoot ? childrenOf(stylesRoot) : [];

  const numberingXml = await readEntryString(zip, "word/numbering.xml");
  const numberingRoot = numberingXml
    ? findDescendant(xmlParser.parse(numberingXml) as XmlChildren, "w:numbering")
    : undefined;
  const numberingTree = numberingRoot ? childrenOf(numberingRoot) : [];

  const relsXml = await readEntryString(zip, "word/_rels/document.xml.rels");
  const rels = new Map<string, string>();
  if (relsXml) {
    const relsTree = xmlParser.parse(relsXml) as XmlChildren;
    const relationships = findDescendant(relsTree, "Relationships");
    for (const rel of relationships ? findChildren(childrenOf(relationships), "Relationship") : []) {
      const id = attr(rel, "Id");
      const target = attr(rel, "Target");
      if (id && target) rels.set(id, target);
    }
  }

  const mediaBytes = new Map<string, Buffer>();
  for (const name of Object.keys(zip.files)) {
    if (name.startsWith("word/media/")) {
      const buf = await readEntryBuffer(zip, name);
      if (buf) mediaBytes.set(name.slice("word/".length), buf); // key as "media/imageN.png"
    }
  }

  return { documentBody, stylesTree, numberingTree, rels, mediaBytes };
}

// ---------------------------------------------------------------------------
// Style resolution: styleId -> resolved rPr/pPr chain, doc default run size.
// ---------------------------------------------------------------------------

interface StyleDef {
  id: string;
  name: string | null;
  basedOn: string | null;
  rPr: XmlNode | null;
}

function buildStyleMap(stylesTree: XmlChildren): Map<string, StyleDef> {
  const map = new Map<string, StyleDef>();
  for (const styleNode of findChildren(stylesTree, "w:style")) {
    const id = attr(styleNode, "w:styleId");
    if (!id) continue;
    const children = childrenOf(styleNode);
    const nameNode = findChild(children, "w:name");
    const basedOnNode = findChild(children, "w:basedOn");
    map.set(id, {
      id,
      name: nameNode ? attr(nameNode, "w:val") ?? null : null,
      basedOn: basedOnNode ? attr(basedOnNode, "w:val") ?? null : null,
      rPr: findChild(children, "w:rPr") ?? null,
    });
  }
  return map;
}

function docDefaultRunSizeHalfPts(stylesTree: XmlChildren): number {
  const docDefaults = findChild(stylesTree, "w:docDefaults");
  if (!docDefaults) return 22; // 11pt, Word's own fallback
  const rPrDefault = findChild(childrenOf(docDefaults), "w:rPrDefault");
  const rPr = rPrDefault ? findChild(childrenOf(rPrDefault), "w:rPr") : undefined;
  const sz = rPr ? findChild(childrenOf(rPr), "w:sz") : undefined;
  const val = sz ? attr(sz, "w:val") : undefined;
  return val ? Number(val) : 22;
}

function docDefaultFont(stylesTree: XmlChildren): string | null {
  const docDefaults = findChild(stylesTree, "w:docDefaults");
  if (!docDefaults) return null;
  const rPrDefault = findChild(childrenOf(docDefaults), "w:rPrDefault");
  const rPr = rPrDefault ? findChild(childrenOf(rPrDefault), "w:rPr") : undefined;
  const rFonts = rPr ? findChild(childrenOf(rPr), "w:rFonts") : undefined;
  return rFonts ? attr(rFonts, "w:ascii") ?? null : null;
}

/** Heading level 1/2/3 for a paragraph style, resolved through w:name (survives localized style names) with a styleId regex fallback. */
function headingLevelForStyle(styleId: string | undefined, styleMap: Map<string, StyleDef>): number | null {
  if (!styleId) return null;
  const def = styleMap.get(styleId);
  const name = def?.name;
  if (name) {
    const m = name.match(/^heading\s*([1-9])$/i);
    if (m) return Number(m[1]);
  }
  const m2 = styleId.match(/^Heading([1-9])$/i);
  return m2 ? Number(m2[1]) : null;
}

// ---------------------------------------------------------------------------
// Run property resolution: docDefaults -> paragraph style chain -> direct pPr/rPr
// -> character style (w:rStyle) -> direct run rPr. Later wins.
// ---------------------------------------------------------------------------

interface ResolvedRunFlags {
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  color?: string | null;
  bg?: string | null;
  szHalfPts?: number;
  font?: string | null;
  vertAlign?: "superscript" | "subscript" | null;
}

function toggleVal(node: XmlNode | undefined): boolean | undefined {
  if (!node) return undefined;
  const v = attr(node, "w:val");
  if (v === undefined) return true; // bare <w:b/> means ON
  return !(v === "0" || v.toLowerCase() === "false");
}

function extractFlagsFromRPr(rPr: XmlNode | null | undefined): ResolvedRunFlags {
  if (!rPr) return {};
  const c = childrenOf(rPr);
  const colorNode = findChild(c, "w:color");
  const colorVal = colorNode ? attr(colorNode, "w:val") : undefined;
  const highlightNode = findChild(c, "w:highlight");
  const highlightVal = highlightNode ? attr(highlightNode, "w:val") : undefined;
  const shdNode = findChild(c, "w:shd");
  const shdFill = shdNode ? attr(shdNode, "w:fill") : undefined;
  const szNode = findChild(c, "w:sz");
  const rFontsNode = findChild(c, "w:rFonts");
  const vertAlignNode = findChild(c, "w:vertAlign");
  const vertAlignVal = vertAlignNode ? attr(vertAlignNode, "w:val") : undefined;

  let bg: string | null | undefined;
  if (highlightVal && highlightVal !== "none") bg = HIGHLIGHT_HEX[highlightVal] ?? null;
  else if (shdFill && shdFill.toLowerCase() !== "auto" && shdFill.toUpperCase() !== "FFFFFF") bg = `#${shdFill.toLowerCase()}`;

  return {
    b: toggleVal(findChild(c, "w:b")),
    i: toggleVal(findChild(c, "w:i")),
    u: findChild(c, "w:u") ? attr(findChild(c, "w:u")!, "w:val") !== "none" : undefined,
    s: toggleVal(findChild(c, "w:strike")),
    color: colorVal ? (colorVal.toLowerCase() === "auto" ? null : `#${colorVal.toLowerCase()}`) : undefined,
    bg,
    szHalfPts: szNode ? Number(attr(szNode, "w:val")) : undefined,
    font: rFontsNode ? attr(rFontsNode, "w:ascii") ?? undefined : undefined,
    vertAlign:
      vertAlignVal === "superscript" ? "superscript" : vertAlignVal === "subscript" ? "subscript" : undefined,
  };
}

function mergeFlags(base: ResolvedRunFlags, over: ResolvedRunFlags): ResolvedRunFlags {
  const out: ResolvedRunFlags = { ...base };
  for (const key of Object.keys(over) as (keyof ResolvedRunFlags)[]) {
    const v = over[key];
    if (v !== undefined) (out as Record<string, unknown>)[key] = v;
  }
  return out;
}

/** Resolves the paragraph style's rPr chain (basedOn ancestors, root first) for a given styleId. */
function styleRPrChain(styleId: string | undefined, styleMap: Map<string, StyleDef>): ResolvedRunFlags {
  if (!styleId) return {};
  const chain: StyleDef[] = [];
  let cur = styleMap.get(styleId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    chain.unshift(cur);
    cur = cur.basedOn ? styleMap.get(cur.basedOn) : undefined;
  }
  let flags: ResolvedRunFlags = {};
  for (const s of chain) flags = mergeFlags(flags, extractFlagsFromRPr(s.rPr));
  return flags;
}

interface StyleContext {
  styleMap: Map<string, StyleDef>;
  docDefaultRPr: ResolvedRunFlags;
  docDefaultSizeHalfPts: number;
  docDefaultFont: string | null;
  rels: Map<string, string>;
}

function resolveRunStyle(
  ctx: StyleContext,
  paragraphStyleId: string | undefined,
  runRPr: XmlNode | undefined,
): InlineStyle | undefined {
  let flags = ctx.docDefaultRPr;
  flags = mergeFlags(flags, styleRPrChain(paragraphStyleId, ctx.styleMap));

  const directFlags = extractFlagsFromRPr(runRPr);
  // Character style referenced via w:rStyle applies before direct formatting.
  const rStyleId = runRPr ? findChild(childrenOf(runRPr), "w:rStyle") : undefined;
  if (rStyleId) {
    const rStyleVal = attr(rStyleId, "w:val");
    flags = mergeFlags(flags, styleRPrChain(rStyleVal, ctx.styleMap));
  }
  flags = mergeFlags(flags, directFlags);

  const style: InlineStyle = {};
  if (flags.b) style.b = true;
  if (flags.i) style.i = true;
  if (flags.u) style.u = true;
  if (flags.s) style.s = true;
  if (flags.vertAlign === "superscript") style.sup = true;
  if (flags.vertAlign === "subscript") style.sub = true;
  if (flags.color) style.color = flags.color;
  if (flags.bg) style.bg = flags.bg;
  if (flags.szHalfPts && flags.szHalfPts !== ctx.docDefaultSizeHalfPts) {
    const ratio = flags.szHalfPts / ctx.docDefaultSizeHalfPts;
    if (Math.abs(ratio - 1) > 0.02) style.sz = Math.round(ratio * 100) / 100;
  }
  if (flags.font && flags.font !== ctx.docDefaultFont) style.font = flags.font;

  return Object.keys(style).length > 0 ? style : undefined;
}

// ---------------------------------------------------------------------------
// Media: content-addressed placeholder naming
// ---------------------------------------------------------------------------

function extFromTarget(target: string): string {
  const m = target.match(/\.([a-zA-Z0-9]+)$/);
  return m ? m[1].toLowerCase() : "png";
}

function makeMediaPlaceholder(bytes: Buffer, ext: string): string {
  const sha16 = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  return `docx-media:${sha16}.${ext}`;
}

// ---------------------------------------------------------------------------
// Run extraction from a <w:p> or <w:hyperlink>'s children
// ---------------------------------------------------------------------------

interface RunExtractionResult {
  runs: Run[];
  images: { placeholder: string; alt?: string; widthPx?: number; heightPx?: number }[];
}

function extractDrawingImage(
  drawingNode: XmlNode,
  ctx: StyleContext,
  media: Map<string, ParsedMedia>,
  rawMediaBytes: Map<string, Buffer>,
  warnings: ParseWarning[],
  paragraphIndex: number,
): { placeholder: string; alt?: string; widthPx?: number; heightPx?: number } | null {
  const blip = findDescendant(childrenOf(drawingNode), "a:blip");
  const relId = blip ? attr(blip, "r:embed") : undefined;
  if (!relId) return null;
  const target = ctx.rels.get(relId);
  if (!target) {
    warnings.push({
      code: "IMAGE_MISSING_RELATIONSHIP",
      message: `Image relationship ${relId} not found in document.xml.rels`,
      paragraphIndex,
    });
    return null;
  }
  const mediaKey = target.replace(/^\.?\/?/, ""); // "media/imageN.png"
  const bytes = rawMediaBytes.get(mediaKey);
  if (!bytes) {
    warnings.push({
      code: "IMAGE_MISSING_RELATIONSHIP",
      message: `Image target ${mediaKey} not found among word/media/*`,
      paragraphIndex,
    });
    return null;
  }
  const ext = extFromTarget(mediaKey);
  const placeholder = makeMediaPlaceholder(bytes, ext);
  if (!media.has(placeholder)) {
    media.set(placeholder, {
      placeholder,
      bytes,
      ext,
      contentType: `image/${ext === "jpg" ? "jpeg" : ext}`,
    });
  }

  const extentNode = findDescendant(childrenOf(drawingNode), "wp:extent");
  const cx = extentNode ? Number(attr(extentNode, "cx")) : undefined;
  const cy = extentNode ? Number(attr(extentNode, "cy")) : undefined;
  const widthPx = cx ? Math.round(cx / 9525) : undefined;
  const heightPx = cy ? Math.round(cy / 9525) : undefined;

  const docPr = findDescendant(childrenOf(drawingNode), "wp:docPr");
  const alt = docPr ? attr(docPr, "descr") ?? attr(docPr, "name") : undefined;

  return { placeholder, alt, widthPx, heightPx };
}

function extractRuns(
  container: XmlChildren,
  paragraphStyleId: string | undefined,
  ctx: StyleContext,
  media: Map<string, ParsedMedia>,
  rawMediaBytes: Map<string, Buffer>,
  warnings: ParseWarning[],
  paragraphIndex: number,
): RunExtractionResult {
  const runs: Run[] = [];
  const images: RunExtractionResult["images"] = [];

  for (const node of container) {
    const tag = tagOf(node);
    if (tag === "w:r") {
      const children = childrenOf(node);
      const rPr = findChild(children, "w:rPr");
      const drawing = findDescendant(children, "w:drawing");
      if (drawing) {
        const img = extractDrawingImage(drawing, ctx, media, rawMediaBytes, warnings, paragraphIndex);
        if (img) images.push(img);
        continue;
      }
      let text = "";
      for (const rc of children) {
        const rcTag = tagOf(rc);
        if (rcTag === "w:t") text += textOf(rc);
        else if (rcTag === "w:tab") text += "\t";
        else if (rcTag === "w:br") text += "\n";
        else if (rcTag === "w:noBreakHyphen") text += "-";
      }
      if (text) {
        const style = resolveRunStyle(ctx, paragraphStyleId, rPr);
        runs.push(style ? { t: text, s: style } : { t: text });
      }
    } else if (tag === "w:hyperlink") {
      const children = childrenOf(node);
      const relId = attr(node, "r:id");
      const anchor = attr(node, "w:anchor");
      const inner = extractRuns(children, paragraphStyleId, ctx, media, rawMediaBytes, warnings, paragraphIndex);
      images.push(...inner.images);
      if (relId) {
        const target = ctx.rels.get(relId);
        if (target && /^https?:\/\//i.test(target)) {
          for (const r of inner.runs) runs.push({ ...r, href: target });
          continue;
        }
      }
      if (anchor) {
        warnings.push({
          code: "HYPERLINK_INTERNAL_FLATTENED",
          message: `Internal link to "${anchor}" flattened to plain text`,
          paragraphIndex,
        });
      }
      runs.push(...inner.runs);
    } else if (tag === "w:ins") {
      // Tracked-change insertion — treat its runs as normal content.
      const inner = extractRuns(childrenOf(node), paragraphStyleId, ctx, media, rawMediaBytes, warnings, paragraphIndex);
      runs.push(...inner.runs);
      images.push(...inner.images);
    }
    // w:del (tracked-change deletions) intentionally skipped — that text was removed by the author.
  }

  return { runs, images };
}

// ---------------------------------------------------------------------------
// Paragraph-level properties: alignment, indent, numbering (list detection)
// ---------------------------------------------------------------------------

function paragraphAlign(pPr: XmlNode | undefined): Align | undefined {
  if (!pPr) return undefined;
  const jc = findChild(childrenOf(pPr), "w:jc");
  const val = jc ? attr(jc, "w:val") : undefined;
  if (!val) return undefined;
  if (val === "both") return "justify";
  if (val === "start" || val === "left") return "left";
  if (val === "end" || val === "right") return "right";
  if (val === "center") return "center";
  return undefined;
}

function paragraphIndentLevel(pPr: XmlNode | undefined): number | undefined {
  if (!pPr) return undefined;
  const ind = findChild(childrenOf(pPr), "w:ind");
  const left = ind ? attr(ind, "w:left") ?? attr(ind, "w:start") : undefined;
  if (!left) return undefined;
  const level = Math.round(Number(left) / 720);
  return Math.min(4, Math.max(0, level));
}

interface NumPr {
  numId: string;
  ilvl: number;
}

function paragraphNumPr(pPr: XmlNode | undefined): NumPr | undefined {
  if (!pPr) return undefined;
  const numPr = findChild(childrenOf(pPr), "w:numPr");
  if (!numPr) return undefined;
  const ilvlNode = findChild(childrenOf(numPr), "w:ilvl");
  const numIdNode = findChild(childrenOf(numPr), "w:numId");
  const numId = numIdNode ? attr(numIdNode, "w:val") : undefined;
  if (!numId || numId === "0") return undefined;
  return { numId, ilvl: ilvlNode ? Number(attr(ilvlNode, "w:val") ?? "0") : 0 };
}

/** numId -> "bullet" | ordered numFmt, per level (0-8), from numbering.xml. */
function buildNumberingMap(numberingTree: XmlChildren): Map<string, Map<number, string>> {
  const abstractByNum = new Map<string, string>(); // numId -> abstractNumId
  for (const numNode of findChildren(numberingTree, "w:num")) {
    const numId = attr(numNode, "w:numId");
    const abstractRef = findChild(childrenOf(numNode), "w:abstractNumId");
    const abstractId = abstractRef ? attr(abstractRef, "w:val") : undefined;
    if (numId && abstractId) abstractByNum.set(numId, abstractId);
  }
  const fmtByAbstract = new Map<string, Map<number, string>>();
  for (const abstractNode of findChildren(numberingTree, "w:abstractNum")) {
    const abstractId = attr(abstractNode, "w:abstractNumId");
    if (!abstractId) continue;
    const levels = new Map<number, string>();
    for (const lvl of findChildren(childrenOf(abstractNode), "w:lvl")) {
      const ilvl = Number(attr(lvl, "w:ilvl") ?? "0");
      const numFmt = findChild(childrenOf(lvl), "w:numFmt");
      levels.set(ilvl, numFmt ? attr(numFmt, "w:val") ?? "decimal" : "decimal");
    }
    fmtByAbstract.set(abstractId, levels);
  }
  const result = new Map<string, Map<number, string>>();
  for (const [numId, abstractId] of abstractByNum) {
    const levels = fmtByAbstract.get(abstractId);
    if (levels) result.set(numId, levels);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Table parsing, with the single-column "infographic container" -> card rule
// ---------------------------------------------------------------------------

function cellParagraphBlocks(
  cellChildren: XmlChildren,
  ctx: StyleContext,
  media: Map<string, ParsedMedia>,
  rawMediaBytes: Map<string, Buffer>,
  warnings: ParseWarning[],
  numberingMap: Map<string, Map<number, string>>,
  paragraphIndex: number,
): Block[] {
  return convertChunksToBlocks(cellChildren, ctx, media, rawMediaBytes, warnings, numberingMap, paragraphIndex);
}

/** Flattens a cell's paragraphs into a single Run[] (joined with a newline run) — used for real (multi-column) table cells. */
function cellToRuns(
  cellChildren: XmlChildren,
  ctx: StyleContext,
  media: Map<string, ParsedMedia>,
  rawMediaBytes: Map<string, Buffer>,
  warnings: ParseWarning[],
  paragraphIndex: number,
): Run[] {
  const out: Run[] = [];
  const paragraphs = findChildren(cellChildren, "w:p");
  paragraphs.forEach((p, i) => {
    const pPr = findChild(childrenOf(p), "w:pPr");
    const pStyleNode = pPr ? findChild(childrenOf(pPr), "w:pStyle") : undefined;
    const styleId = pStyleNode ? attr(pStyleNode, "w:val") : undefined;
    const { runs } = extractRuns(childrenOf(p), styleId, ctx, media, rawMediaBytes, warnings, paragraphIndex);
    if (i > 0 && runs.length > 0) out.push({ t: "\n" });
    out.push(...runs);
  });
  return out;
}

function parseTable(
  tblNode: XmlNode,
  ctx: StyleContext,
  media: Map<string, ParsedMedia>,
  rawMediaBytes: Map<string, Buffer>,
  warnings: ParseWarning[],
  numberingMap: Map<string, Map<number, string>>,
  paragraphIndex: number,
): Block {
  const children = childrenOf(tblNode);
  const tblGrid = findChild(children, "w:tblGrid");
  const gridCols = tblGrid ? findChildren(childrenOf(tblGrid), "w:gridCol") : [];
  const colWidths = gridCols.map((g) => Number(attr(g, "w:w") ?? "0"));
  const totalWidth = colWidths.reduce((a, b) => a + b, 0);

  const rows = findChildren(children, "w:tr");

  // Single-grid-column tables are used throughout the English source as
  // layout containers for infographics, not tabular data — 49 of 89 tables
  // in the original master file. Rendering them as <table> would produce
  // dozens of pointless horizontal scrollers on a phone, so unwrap into a
  // "card" holding the recursively-parsed content instead.
  if (gridCols.length <= 1) {
    const blocks: Block[] = [];
    for (const row of rows) {
      const cells = findChildren(childrenOf(row), "w:tc");
      for (const cell of cells) {
        blocks.push(
          ...cellParagraphBlocks(childrenOf(cell), ctx, media, rawMediaBytes, warnings, numberingMap, paragraphIndex),
        );
      }
    }
    return { type: "card", blocks };
  }

  const rowRuns: Run[][][] = [];
  let head: Run[][] | undefined;

  rows.forEach((row, rowIdx) => {
    const cells = findChildren(childrenOf(row), "w:tc");
    const trPr = findChild(childrenOf(row), "w:trPr");
    const isHeaderRow = trPr ? !!findChild(childrenOf(trPr), "w:tblHeader") : false;
    const cellRuns = cells.map((cell) =>
      cellToRuns(childrenOf(cell), ctx, media, rawMediaBytes, warnings, paragraphIndex),
    );
    const allBold =
      cellRuns.length > 0 && cellRuns.every((runs) => runs.length > 0 && runs.every((r) => r.s?.b));
    if (rowIdx === 0 && (isHeaderRow || allBold)) {
      head = cellRuns;
    } else {
      rowRuns.push(cellRuns);
    }
  });

  const widths = totalWidth > 0 ? colWidths.map((w) => Math.round((w / totalWidth) * 1000) / 10) : undefined;

  return { type: "table", head, rows: rowRuns, widths };
}

// ---------------------------------------------------------------------------
// Body-chunk -> Block[] conversion (shared by intro/section/outro/card content)
// ---------------------------------------------------------------------------

function convertChunksToBlocks(
  chunks: XmlChildren,
  ctx: StyleContext,
  media: Map<string, ParsedMedia>,
  rawMediaBytes: Map<string, Buffer>,
  warnings: ParseWarning[],
  numberingMap: Map<string, Map<number, string>>,
  startIndex: number,
): Block[] {
  const blocks: Block[] = [];
  let openList: { ordered: boolean; items: { runs: Run[]; level: number }[] } | null = null;

  const flushList = () => {
    if (openList && openList.items.length > 0) blocks.push({ type: "list", ordered: openList.ordered, items: openList.items });
    openList = null;
  };

  chunks.forEach((node, i) => {
    const paragraphIndex = startIndex + i;
    const tag = tagOf(node);
    if (tag === "w:tbl") {
      flushList();
      blocks.push(parseTable(node, ctx, media, rawMediaBytes, warnings, numberingMap, paragraphIndex));
      return;
    }
    if (tag !== "w:p") return;

    const children = childrenOf(node);
    const pPr = findChild(children, "w:pPr");
    const pStyleNode = pPr ? findChild(childrenOf(pPr), "w:pStyle") : undefined;
    const styleId = pStyleNode ? attr(pStyleNode, "w:val") : undefined;
    const headingLevel = headingLevelForStyle(styleId, ctx.styleMap);

    const { runs, images } = extractRuns(children, styleId, ctx, media, rawMediaBytes, warnings, paragraphIndex);

    // A paragraph whose only content is a single embedded image becomes an
    // `image` block rather than a paragraph wrapping an image.
    if (runs.length === 0 && images.length === 1) {
      flushList();
      const img = images[0];
      blocks.push({ type: "image", url: img.placeholder, alt: img.alt, widthPx: img.widthPx, heightPx: img.heightPx });
      return;
    }
    if (runs.length === 0 && images.length > 1) {
      flushList();
      for (const img of images) {
        blocks.push({ type: "image", url: img.placeholder, alt: img.alt, widthPx: img.widthPx, heightPx: img.heightPx });
      }
      return;
    }

    if (runs.length === 0) return; // fully empty paragraph — spacing only

    // H4+ (headingLevel >= 4 is never produced by headingLevelForStyle's
    // regex range 1-9 collapsing at the block schema level) — any level
    // beyond 3 is demoted to a level-3 heading block with a warning.
    if (headingLevel && headingLevel >= 3) {
      flushList();
      if (headingLevel > 3) {
        warnings.push({
          code: "HEADING_DEMOTED",
          message: `Heading${headingLevel} demoted to a level-3 heading (only one level of sub-heading is supported)`,
          paragraphIndex,
          excerpt: runs.map((r) => r.t).join("").slice(0, 120),
        });
      }
      blocks.push({ type: "heading", level: 3, runs, align: paragraphAlign(pPr) });
      for (const img of images) blocks.push({ type: "image", url: img.placeholder, alt: img.alt, widthPx: img.widthPx, heightPx: img.heightPx });
      return;
    }

    const numPr = paragraphNumPr(pPr);
    if (numPr) {
      const levels = numberingMap.get(numPr.numId);
      const fmt = levels?.get(numPr.ilvl) ?? "decimal";
      const ordered = fmt !== "bullet";
      if (!openList || openList.ordered !== ordered) {
        flushList();
        openList = { ordered, items: [] };
      }
      openList.items.push({ runs, level: Math.min(2, numPr.ilvl) });
      for (const img of images) blocks.push({ type: "image", url: img.placeholder, alt: img.alt, widthPx: img.widthPx, heightPx: img.heightPx });
      return;
    }

    flushList();
    blocks.push({ type: "paragraph", runs, align: paragraphAlign(pPr), indent: paragraphIndentLevel(pPr) });
    for (const img of images) blocks.push({ type: "image", url: img.placeholder, alt: img.alt, widthPx: img.widthPx, heightPx: img.heightPx });
  });

  flushList();
  return blocks;
}

// ---------------------------------------------------------------------------
// Section number extraction: "2.1 What is opportunity cost?" -> ("2.1", "What is opportunity cost?")
// ---------------------------------------------------------------------------

function splitSectionNumber(heading: string): { displayNo: string; title: string } | null {
  const m = heading.match(/^(\d+\.\d+)\s+(.+)$/);
  if (!m) return null;
  return { displayNo: m[1], title: m[2].trim() };
}

function stripLeadingNumberFromRuns(runs: Run[], displayNo: string): Run[] {
  const prefix = `${displayNo} `;
  if (runs.length === 0) return runs;
  const first = runs[0];
  if (!first.t.startsWith(prefix)) return runs;
  const rest = first.t.slice(prefix.length);
  if (!rest) return runs.slice(1);
  return [{ ...first, t: rest }, ...runs.slice(1)];
}

// ---------------------------------------------------------------------------
// Review Questions extraction (module-level, per user decision: quiz is
// per-module using the author's 3 open-ended prompts verbatim).
// ---------------------------------------------------------------------------

function extractReviewQuestions(blocks: Block[], startParagraphIndex: number): {
  questions: ParsedReviewQuestion[];
  errors: ParseError[];
} {
  const errors: ParseError[] = [];
  const questions: ParsedReviewQuestion[] = [];

  // The real corpus authors these as a genuine Word numbered list
  // (w:numPr, numFmt=decimal) under the "Review Questions" Heading3, not as
  // manually typed "1. ..." paragraphs — convertChunksToBlocks already
  // turns that into a single `list` block with 3 items. Prefer it.
  const listBlock = blocks.find((b): b is Extract<Block, { type: "list" }> => b.type === "list");
  if (listBlock) {
    listBlock.items.forEach((item, i) => {
      const prompt = item.runs.map((r) => r.t).join("").trim();
      if (!prompt) errors.push({ code: "REVIEW_QUESTION_TEXT_EMPTY", message: `Review question ${i + 1} has empty text` });
      questions.push({ position: i + 1, prompt });
    });
  } else {
    // Fallback for a docx that types "1. ..." / "2. ..." as plain paragraphs
    // instead of using Word's list feature.
    for (const block of blocks) {
      if (block.type !== "paragraph") continue;
      const text = block.runs.map((r) => r.t).join("").trim();
      const m = text.match(/^([1-3])[.)]\s*(.+)$/);
      if (m) {
        const prompt = m[2].trim();
        if (!prompt) errors.push({ code: "REVIEW_QUESTION_TEXT_EMPTY", message: `Review question ${m[1]} has empty text` });
        questions.push({ position: Number(m[1]), prompt });
      }
    }
  }
  if (questions.length === 0) {
    errors.push({
      code: "REVIEW_QUESTIONS_MISSING",
      message: "No Review Questions block found — a module needs exactly 3 numbered review questions",
      paragraphIndex: startParagraphIndex,
    });
  } else if (questions.length !== 3) {
    errors.push({
      code: "REVIEW_QUESTIONS_COUNT",
      message: `Expected exactly 3 review questions, found ${questions.length}`,
      paragraphIndex: startParagraphIndex,
    });
  }
  return { questions, errors };
}

// ---------------------------------------------------------------------------
// Top-level: body chunks -> ParsedModule
// ---------------------------------------------------------------------------

export async function parseModuleDocx(docxBuffer: Buffer): Promise<ParsedModule> {
  const parts = await loadDocxParts(docxBuffer);
  const styleMap = buildStyleMap(parts.stylesTree);
  const numberingMap = buildNumberingMap(parts.numberingTree);
  const docDefaultSizeHalfPts = docDefaultRunSizeHalfPts(parts.stylesTree);
  const docDefaultFontFamily = docDefaultFont(parts.stylesTree);
  const docDefaultRPr = extractFlagsFromRPr(
    (() => {
      const dd = findChild(parts.stylesTree, "w:docDefaults");
      const rd = dd ? findChild(childrenOf(dd), "w:rPrDefault") : undefined;
      return rd ? findChild(childrenOf(rd), "w:rPr") ?? null : null;
    })(),
  );

  const ctx: StyleContext = {
    styleMap,
    docDefaultRPr,
    docDefaultSizeHalfPts,
    docDefaultFont: docDefaultFontFamily,
    rels: parts.rels,
  };

  const errors: ParseError[] = [];
  const warnings: ParseWarning[] = [];
  const media = new Map<string, ParsedMedia>();

  // --- Split the body into: [Heading1 title] [intro chunks] [section1 H2 + chunks] [section2 ...] [outro after last numbered section]
  const h1Nodes = parts.documentBody.filter((n) => {
    const style = (() => {
      if (tagOf(n) !== "w:p") return undefined;
      const pPr = findChild(childrenOf(n), "w:pPr");
      const pStyleNode = pPr ? findChild(childrenOf(pPr), "w:pStyle") : undefined;
      return pStyleNode ? attr(pStyleNode, "w:val") : undefined;
    })();
    return headingLevelForStyle(style, styleMap) === 1;
  });

  if (h1Nodes.length === 0) {
    errors.push({ code: "MODULE_NO_H1", message: "Module docx has no Heading1 — cannot determine the module title" });
  } else if (h1Nodes.length > 1) {
    errors.push({
      code: "MODULE_MULTIPLE_H1",
      message: `Module docx has ${h1Nodes.length} Heading1 headings — a module docx must have exactly one (req 6: each module gets its own docx)`,
    });
  }

  const h1Index = parts.documentBody.indexOf(h1Nodes[0]);
  const titleNode = h1Nodes[0];
  const { runs: titleRuns } = titleNode
    ? extractRuns(childrenOf(titleNode), undefined, ctx, media, parts.mediaBytes, warnings, h1Index)
    : { runs: [] };
  const title = titleRuns.map((r) => r.t).join("");

  const rest = h1Index >= 0 ? parts.documentBody.slice(h1Index + 1) : parts.documentBody;

  // Walk `rest`, splitting on Heading2 boundaries.
  type Segment = { kind: "intro" | "section" | "outro"; headingText?: string; headingRuns?: Run[]; chunks: XmlNode[]; startIndex: number };
  const segments: Segment[] = [{ kind: "intro", chunks: [], startIndex: h1Index + 1 }];
  let sawNumberedSection = false;
  let sawAnyTrailerHeading = false; // true once a real Heading3 (Key Concepts/Takeaways/Review Questions/Summary) is seen

  rest.forEach((node, i) => {
    const paragraphIndex = h1Index + 1 + i;
    if (tagOf(node) === "w:p") {
      const pPr = findChild(childrenOf(node), "w:pPr");
      const pStyleNode = pPr ? findChild(childrenOf(pPr), "w:pStyle") : undefined;
      const styleId = pStyleNode ? attr(pStyleNode, "w:val") : undefined;
      const level = headingLevelForStyle(styleId, styleMap);
      if (level === 2) {
        const { runs } = extractRuns(childrenOf(node), styleId, ctx, media, parts.mediaBytes, warnings, paragraphIndex);
        const headingText = runs.map((r) => r.t).join("");
        const isNumbered = /^\d+\.\d+\s/.test(headingText);
        if (isNumbered) sawNumberedSection = true;
        segments.push({
          kind: isNumbered ? "section" : sawNumberedSection ? "outro" : "intro",
          headingText,
          headingRuns: runs,
          chunks: [],
          startIndex: paragraphIndex + 1,
        });
        return;
      }
      // Key Concepts / Key Takeaways / Review Questions / Module Summary are
      // Heading3 trailer markers that follow the last numbered section in
      // this corpus (confirmed against all 12 real module docx: exactly 4
      // per module, always clustered at the end). Once we're past the first
      // numbered section, an H3 also opens a new segment rather than being
      // folded into the open section's blocks — otherwise Review Questions
      // would be indistinguishable from ordinary section prose and could
      // never be extracted as quiz prompts. An H3 encountered before any
      // numbered section (not present in the real corpus, but possible in a
      // future upload) is left as an ordinary inline heading block per the
      // block schema's "H3 never creates a section" rule.
      if (level === 3 && sawNumberedSection) {
        sawAnyTrailerHeading = true;
        const { runs } = extractRuns(childrenOf(node), styleId, ctx, media, parts.mediaBytes, warnings, paragraphIndex);
        const headingText = runs.map((r) => r.t).join("");
        segments.push({ kind: "outro", headingText, headingRuns: runs, chunks: [], startIndex: paragraphIndex + 1 });
        return;
      }
    }
    segments[segments.length - 1].chunks.push(node);
  });

  const introBlocks: Block[] = [];
  const outroBlocks: Block[] = [];
  const sections: ParsedSection[] = [];
  let reviewQuestionBlocks: Block[] = [];
  let reviewQuestionsStartIndex = 0;

  for (const seg of segments) {
    if (seg.kind === "intro" && !seg.headingText) {
      introBlocks.push(...convertChunksToBlocks(seg.chunks, ctx, media, parts.mediaBytes, warnings, numberingMap, seg.startIndex));
      continue;
    }
    if (seg.kind === "intro" && seg.headingText) {
      // Non-numbered H2 before the first section (e.g. "Learning Objectives", "Introduction").
      introBlocks.push({ type: "heading", level: 3, runs: seg.headingRuns ?? [] });
      introBlocks.push(...convertChunksToBlocks(seg.chunks, ctx, media, parts.mediaBytes, warnings, numberingMap, seg.startIndex));
      continue;
    }
    if (seg.kind === "section") {
      const split = splitSectionNumber(seg.headingText ?? "");
      const displayNo = split?.displayNo ?? String(sections.length + 1);
      const title = split?.title ?? (seg.headingText ?? "");
      const titleRuns = stripLeadingNumberFromRuns(seg.headingRuns ?? [], displayNo);
      sections.push({
        displayNo,
        title,
        titleRuns,
        blocks: convertChunksToBlocks(seg.chunks, ctx, media, parts.mediaBytes, warnings, numberingMap, seg.startIndex),
      });
      continue;
    }
    // outro: Key Concepts / Key Takeaways / Module Summary / Review Questions.
    const isReviewQuestions = seg.headingText ? /^Review Questions|^स्वाध्याय प्रश्न/i.test(seg.headingText) : false;
    const segBlocks = convertChunksToBlocks(seg.chunks, ctx, media, parts.mediaBytes, warnings, numberingMap, seg.startIndex);
    if (isReviewQuestions) {
      reviewQuestionBlocks = segBlocks;
      reviewQuestionsStartIndex = seg.startIndex;
      continue; // Review Questions are extracted separately, not rendered as outro prose.
    }
    if (seg.headingText) outroBlocks.push({ type: "heading", level: 3, runs: seg.headingRuns ?? [] });
    outroBlocks.push(...segBlocks);
  }

  // Module 0 (front matter — Cover/Foreword/Preface/How to Use/Course
  // Structure) has no Key Concepts/Takeaways/Review Questions/Summary
  // trailer at all; it is administrative content, not a quizzable learning
  // module, so it is exempt from the "exactly 3 review questions" rule
  // rather than failing every front-matter upload. A real content module
  // always carries the trailer structure (confirmed against all 12 module
  // docx: H3 count is 0 for module 0, exactly 4 for modules 1-6).
  const { questions, errors: quizErrors } = sawAnyTrailerHeading
    ? extractReviewQuestions(reviewQuestionBlocks, reviewQuestionsStartIndex)
    : { questions: [] as ParsedReviewQuestion[], errors: [] as ParseError[] };
  errors.push(...quizErrors);

  return {
    title,
    titleRuns,
    introBlocks,
    sections,
    outroBlocks,
    reviewQuestions: questions,
    media: Array.from(media.values()),
    warnings,
    errors,
  };
}
