import { promises as fs } from "node:fs";
import path from "node:path";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeSlug from "rehype-slug";
import rehypePrettyCode from "rehype-pretty-code";
import rehypeStringify from "rehype-stringify";
import { SITE_DESCRIPTION } from "@/lib/site";

export { NAV, getDocSlugs } from "@/lib/docs-nav";
export type { NavItem, NavSection } from "@/lib/docs-nav";

const CONTENT_DIR = path.join(process.cwd(), "content");

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSlug)
  .use(rehypePrettyCode, {
    theme: { light: "github-light", dark: "github-dark" },
    keepBackground: false,
  })
  .use(rehypeStringify);

export interface RenderedDoc {
  html: string;
  title: string;
  description: string;
}

const MAX_DESCRIPTION_LENGTH = 160;

// First real paragraph of the document, flattened to plain text so it can be
// used as a meta description. Headings, code fences, lists, and quotes are
// skipped because they do not read as a summary.
function extractDescription(markdown: string): string {
  const blocks = markdown.replace(/^```[\s\S]*?^```$/gm, "").split(/\n\s*\n/);
  const paragraph = blocks
    .map((block) => block.trim())
    .find((block) => block.length > 0 && !/^[#>\-*\d|]/.test(block));
  if (!paragraph) return SITE_DESCRIPTION;

  const text = paragraph
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text;

  const clipped = text.slice(0, MAX_DESCRIPTION_LENGTH);
  const lastSpace = clipped.lastIndexOf(" ");
  const trimmed = lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped;
  return `${trimmed.trimEnd()}…`;
}

export async function getDoc(slug: string[]): Promise<RenderedDoc | null> {
  const relative = slug.length ? path.join(...slug) : "index";
  const filePath = path.join(CONTENT_DIR, `${relative}.md`);
  if (!filePath.startsWith(CONTENT_DIR)) {
    return null;
  }

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const title = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "NoSkrap Docs";
  const description = extractDescription(raw.replace(/^#\s+.+$/m, ""));
  let html = String(await processor.process(raw));
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  if (basePath) {
    html = html.replaceAll('href="/', `href="${basePath}/`);
  }
  return { html, title, description };
}
