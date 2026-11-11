/**
 * Faithful Markdown question parsing (AGENTS.md §2/§5). Uses unified + remark to
 * read structure and the `yaml` package for front-matter — no hand-written
 * format parser. Front-matter carries only PUBLIC metadata; the body is the
 * stem (text, LaTeX, options, sub-questions) preserved verbatim. Image
 * references in the body become public attachments (original figures provided
 * directly in both modes, not as a tool call).
 */
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkFrontmatter from "remark-frontmatter";
import YAML from "yaml";
import { extname } from "node:path";

export interface ParsedQuestion {
  frontmatter: Record<string, unknown>;
  body: string;
  imageRefs: Array<{ alt: string; ref: string }>;
}

const EXT_MEDIA: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export function mediaTypeForRef(ref: string): string | undefined {
  return EXT_MEDIA[extname(ref).toLowerCase()];
}

function stripFrontmatter(md: string): string {
  const m = md.match(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m ? md.slice(m[0].length) : md;
}

export function parseQuestionMarkdown(md: string): ParsedQuestion {
  const tree = unified().use(remarkParse).use(remarkFrontmatter, ["yaml"]).parse(md) as unknown;
  let frontmatter: Record<string, unknown> = {};
  const imageRefs: Array<{ alt: string; ref: string }> = [];

  const walk = (node: { type?: string; value?: unknown; url?: unknown; alt?: unknown; children?: unknown[] }) => {
    if (node.type === "yaml") {
      frontmatter = (YAML.parse(String(node.value)) ?? {}) as Record<string, unknown>;
    }
    if (node.type === "image") {
      imageRefs.push({ alt: typeof node.alt === "string" ? node.alt : "", ref: String(node.url) });
    }
    for (const child of node.children ?? []) walk(child as typeof node);
  };
  walk(tree as never);

  return { frontmatter, body: stripFrontmatter(md), imageRefs };
}

const OPTION_LINE_RE = /^\s*(?:[-*+]\s+)?[（(]?([A-Za-z])[)）.、．]\s*(.+?)\s*$/;

/**
 * Extract structured choice options from a contiguous block of option lines in
 * the body (e.g. "- A. 3"). Returns {} unless a run of >= 2 option lines is
 * found, to avoid false positives on prose that merely starts with a letter.
 */
export function parseOptionsFromBody(body: string): Record<string, string> {
  const lines = body.split(/\r?\n/);
  let best: Array<[string, string]> = [];
  let run: Array<[string, string]> = [];
  for (const line of lines) {
    const m = line.match(OPTION_LINE_RE);
    if (m && m[2] && m[2].length > 0) {
      run.push([m[1]!, m[2]]);
    } else {
      if (run.length > best.length) best = run;
      run = [];
    }
  }
  if (run.length > best.length) best = run;
  if (best.length < 2) return {};
  const out: Record<string, string> = {};
  for (const [label, text] of best) out[label] = text;
  return out;
}
