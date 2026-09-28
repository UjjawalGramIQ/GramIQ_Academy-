/**
 * Generic helpers over fast-xml-parser's `preserveOrder` tree shape.
 *
 * With `preserveOrder: true`, every XML element becomes an array entry
 * shaped like `{ "<tagname>": [...children], ":@": { "@_attr": "value" } }`.
 * Text nodes are `{ "#text": "..." }`. This module is deliberately generic
 * (no OOXML-specific knowledge) — `docx-parser.ts` is where WordprocessingML
 * semantics live.
 */

export type XmlNode = Record<string, unknown> & { ":@"?: Record<string, string> };
export type XmlChildren = XmlNode[];

/** The single tag-name key of a preserveOrder node (every node except text/attr wrappers has exactly one). */
export function tagOf(node: XmlNode): string | null {
  for (const key of Object.keys(node)) {
    if (key !== ":@" && key !== "#text") return key;
  }
  return null;
}

export function childrenOf(node: XmlNode): XmlChildren {
  const tag = tagOf(node);
  if (!tag) return [];
  const v = node[tag];
  return Array.isArray(v) ? (v as XmlChildren) : [];
}

export function attr(node: XmlNode, name: string): string | undefined {
  return node[":@"]?.[`@_${name}`];
}

/** First direct child matching `tag`, or undefined. */
export function findChild(children: XmlChildren, tag: string): XmlNode | undefined {
  return children.find((c) => tagOf(c) === tag);
}

/** All direct children matching `tag`. */
export function findChildren(children: XmlChildren, tag: string): XmlNode[] {
  return children.filter((c) => tagOf(c) === tag);
}

/** Depth-first search for the first descendant matching `tag` (used sparingly — prefer direct-child lookups where the schema allows). */
export function findDescendant(children: XmlChildren, tag: string): XmlNode | undefined {
  for (const c of children) {
    if (tagOf(c) === tag) return c;
    const found = findDescendant(childrenOf(c), tag);
    if (found) return found;
  }
  return undefined;
}

/** Concatenated `#text` of every text node under `node` (direct + nested), honoring xml:space via the caller. */
export function textOf(node: XmlNode): string {
  let out = "";
  for (const c of childrenOf(node)) {
    if ("#text" in c) out += String(c["#text"]);
    else out += textOf(c);
  }
  return out;
}
