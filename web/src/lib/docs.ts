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

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/**
 * Docs tables are wider than a phone. Wrap every table so it scrolls inside
 * its own box instead of stretching the page.
 */
function rehypeScrollableTables() {
  return (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (!node.children) return;
      node.children = node.children.map((child) => {
        walk(child);
        if (child.type !== "element" || child.tagName !== "table") return child;
        return {
          type: "element",
          tagName: "div",
          properties: { className: ["overflow-x-auto"] },
          children: [child],
        } satisfies HastNode;
      });
    };
    walk(tree);
  };
}

export interface TocItem {
  id: string;
  title: string;
  depth: 2 | 3;
}

declare module "vfile" {
  interface DataMap {
    toc: TocItem[];
  }
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function containsLink(node: HastNode): boolean {
  return (node.children ?? []).some(
    (child) => child.tagName === "a" || containsLink(child),
  );
}

/**
 * Collect h2/h3 for the "On this page" outline and turn each heading into a
 * link to itself. Runs after rehype-slug so every heading already has an id.
 */
function rehypeHeadingLinks() {
  return (tree: HastNode, file: { data: { toc?: TocItem[] } }) => {
    const toc: TocItem[] = [];
    const walk = (node: HastNode) => {
      for (const child of node.children ?? []) {
        const depth = child.tagName === "h2" ? 2 : child.tagName === "h3" ? 3 : 0;
        const id = child.properties?.id;
        if (child.type !== "element" || !depth || typeof id !== "string") {
          walk(child);
          continue;
        }
        toc.push({ id, title: textOf(child), depth });
        // A heading that already holds a link cannot wrap another one.
        if (!containsLink(child)) {
          child.children = [
            {
              type: "element",
              tagName: "a",
              properties: { href: `#${id}`, className: ["heading-anchor"] },
              children: child.children ?? [],
            },
          ];
        }
      }
    };
    walk(tree);
    file.data.toc = toc;
  };
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype)
  .use(rehypeSlug)
  .use(rehypeHeadingLinks)
  .use(rehypeScrollableTables)
  .use(rehypePrettyCode, {
    theme: { light: "github-light", dark: "github-dark" },
    keepBackground: false,
  })
  .use(rehypeStringify);

export interface RenderedDoc {
  html: string;
  title: string;
  description: string;
  toc: TocItem[];
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
  const file = await processor.process(raw);
  let html = String(file);
  const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";
  if (basePath) {
    html = html.replaceAll('href="/', `href="${basePath}/`);
  }
  return { html, title, description, toc: file.data.toc ?? [] };
}
