import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/code-block";
import { asset } from "@/lib/asset";

const DOCS_URL = "/docs";
const GITHUB_URL = "https://github.com/kacigaya/noskrap";

const FEATURES = [
  {
    title: "Start in observe mode",
    description:
      "Ship the proxy without blocking anyone. Watch scores, reasons, and cookies before you enforce.",
  },
  {
    title: "See why traffic scored",
    description:
      "Each decision carries stable rule ids, so logs explain what changed instead of saying bot magic.",
  },
  {
    title: "Protect noisy endpoints",
    description:
      "Apply checks where scraping hurts: search, login, checkout, and other expensive routes.",
  },
  {
    title: "Challenge without lock-in",
    description:
      "Use your own check page or CAPTCHA provider, then issue a short-lived signed pass.",
  },
  {
    title: "Ask for coarse signals",
    description:
      "Record recent interaction timestamps, not full event streams.",
  },
  {
    title: "Tell users what happened",
    description:
      "Show a simple bot-detected popup, or wire the helper into your own toast or modal.",
  },
];

const QUICKSTART = `import { createNoSkrapProxy } from "noskrap/next";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export const proxy = createNoSkrapProxy({
  secret: process.env.NOSKRAP_SECRET!,
  protectedRoutes: ["/api/search", "/login", "/checkout"],
});`;

const INSTALL = `bun add noskrap`;

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main id="main-content" tabIndex={-1} className="flex flex-1 flex-col">
        {/* Hero */}
        <section className="mx-auto flex w-full max-w-5xl flex-col items-center px-6 py-24 text-center">
          <Image
            src={asset("/noskrap-logo.svg")}
            alt="NoSkrap logo"
            width={96}
            height={96}
            className="mb-8"
            loading="eager"
          />
          <Badge variant="secondary" className="mb-6">
            Next.js · TypeScript · Bot-risk scoring
          </Badge>
          <h1 className="text-balance font-heading text-5xl font-bold tracking-tight sm:text-6xl">
            Protect Next.js routes without guessing who is human
          </h1>
          <p className="mt-6 max-w-2xl text-pretty text-lg text-muted-foreground">
            NoSkrap gives every request an explainable risk score. Start by
            watching traffic, then challenge or block the routes that bots make
            expensive.
          </p>
          <div className="mt-10 flex flex-col gap-3 sm:flex-row">
            <Button size="xl" render={<Link href={DOCS_URL} />}>
              View Documentation
            </Button>
            <Button size="xl" variant="outline" render={<a href={GITHUB_URL} />}>
              Star on GitHub
            </Button>
          </div>
        </section>

        {/* Install */}
        <section className="mx-auto w-full max-w-3xl px-6 pb-24">
          <CodeBlock code={INSTALL} lang="bash" />
        </section>

        {/* Features */}
        <section className="mx-auto w-full max-w-5xl px-6 pb-24">
          <h2 className="mb-10 text-balance text-center font-heading text-3xl font-bold tracking-tight">
            Built for the messy middle between allow and block
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map((feature) => (
              <Card key={feature.title}>
                <CardHeader>
                  <CardTitle render={<h3 />}>{feature.title}</CardTitle>
                  <CardDescription render={<p />} className="text-pretty">
                    {feature.description}
                  </CardDescription>
                </CardHeader>
              </Card>
            ))}
          </div>
        </section>

        {/* Quickstart */}
        <section className="mx-auto w-full max-w-3xl px-6 pb-24">
          <h2 className="mb-6 text-balance text-center font-heading text-3xl font-bold tracking-tight">
            Quickstart
          </h2>
          <p className="mb-4 text-pretty text-sm text-muted-foreground">
            Next.js 16: proxy.ts with the proxy export. Next.js 15: middleware.ts
            with the middleware export. Use shared storage in production.
          </p>
          <CodeBlock code={QUICKSTART} lang="ts" />
        </section>

      </main>
      {/* Footer */}
      <SiteFooter />
    </>
  );
}
