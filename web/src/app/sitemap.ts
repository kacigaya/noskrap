import type { MetadataRoute } from "next";
import { getDocSlugs } from "@/lib/docs-nav";
import { SITE_URL } from "@/lib/site";

// `output: export` requires metadata routes to be explicitly static.
export const dynamic = "force-static";

export default function sitemap(): MetadataRoute.Sitemap {
  const docs = getDocSlugs().map((slug) => ({
    url: `${SITE_URL}/docs/${slug.join("/")}${slug.length ? "/" : ""}`,
    changeFrequency: "monthly" as const,
    priority: slug.length ? 0.6 : 0.8,
  }));

  return [
    { url: `${SITE_URL}/`, changeFrequency: "monthly", priority: 1 },
    ...docs,
  ];
}
