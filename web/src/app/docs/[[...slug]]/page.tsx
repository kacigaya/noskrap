import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDoc, getDocSlugs } from "@/lib/docs";
import { SITE_NAME } from "@/lib/site";
import { CodeCopy } from "@/components/code-copy";

export const dynamicParams = false;

export function generateStaticParams() {
  return getDocSlugs().map((slug) => ({ slug }));
}

interface DocPageProps {
  params: Promise<{ slug?: string[] }>;
}

export async function generateMetadata(props: DocPageProps): Promise<Metadata> {
  const { slug = [] } = await props.params;
  const doc = await getDoc(slug);
  if (!doc) return { title: "Documentation" };

  // The docs index reuses the site name as its heading; the root layout title
  // template would otherwise render it twice.
  const title = doc.title === SITE_NAME ? "Documentation" : doc.title;
  // `trailingSlash: true` serves these routes with a trailing slash, so the
  // canonical URL has to carry one too or it points at a redirect.
  const url = `/docs/${slug.join("/")}${slug.length ? "/" : ""}`;

  // Social cards do not inherit the title template, so spell out the suffix.
  const socialTitle = `${title} — ${SITE_NAME}`;

  return {
    title,
    description: doc.description,
    alternates: { canonical: url },
    openGraph: {
      type: "article",
      url,
      title: socialTitle,
      description: doc.description,
    },
    twitter: { title: socialTitle, description: doc.description },
  };
}

export default async function DocPage(props: DocPageProps) {
  const { slug = [] } = await props.params;
  const doc = await getDoc(slug);
  if (!doc) notFound();

  return (
    <>
      <article
        className="prose prose-neutral max-w-none dark:prose-invert prose-headings:scroll-mt-24 prose-pre:rounded-2xl prose-pre:border prose-pre:bg-card prose-pre:p-6 prose-a:text-primary"
        dangerouslySetInnerHTML={{ __html: doc.html }}
      />
      <CodeCopy />
    </>
  );
}
