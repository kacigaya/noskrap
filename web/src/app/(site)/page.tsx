import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CodeBlock } from "@/components/code-block";
import { ThemeToggle } from "@/components/theme-toggle";
import { asset } from "@/lib/asset";

const DOCS_URL = "/docs";
const GITHUB_URL = "https://github.com/kacigaya/noskrap";

const FEATURES = [
  {
    title: "Request scoring",
    description:
      "Score each request with header, fetch metadata, continuity, interaction, and rate signals.",
  },
  {
    title: "Explainable reasons",
    description:
      "Every score contribution includes a stable rule id so logs and dashboards stay readable.",
  },
  {
    title: "Enforce mode",
    description:
      "Return 403 for block decisions or redirect challenge decisions to your own check page.",
  },
  {
    title: "Challenge pass",
    description:
      "Issue a short-lived signed pass after your app verifies a visitor; block still wins.",
  },
  {
    title: "Interaction telemetry",
    description:
      "Record coarse page-view and interaction timestamps without storing sensitive event streams.",
  },
  {
    title: "Client popup",
    description:
      "Use a tiny browser helper to show a bot-detected popup for challenge and block decisions.",
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
    <main className="flex flex-1 flex-col">
      {/* Nav */}
      <header className="sticky top-0 z-20 px-4 pt-4">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between rounded-2xl border bg-background/70 px-5 py-3 shadow-sm backdrop-blur-md">
          <div className="flex items-center gap-2.5">
            <Image src={asset("/noskrap-logo.svg")} alt="NoSkrap" width={28} height={28} />
            <span className="font-semibold tracking-tight">NoSkrap</span>
          </div>
          <nav className="flex items-center gap-2">
            <ThemeToggle />
            <Button variant="ghost" size="sm" render={<Link href={DOCS_URL} />}>
              Docs
            </Button>
            <Button variant="outline" size="sm" render={<a href={GITHUB_URL} />}>
              GitHub
            </Button>
          </nav>
        </div>
      </header>

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
        <h1 className="font-heading text-5xl font-bold tracking-tight sm:text-6xl">
          Bot-risk decisions for Next.js apps
        </h1>
        <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
          NoSkrap scores requests with explainable signals, signed visitor continuity,
          interaction telemetry, and enforce-mode responses. Start in observe mode, then
          challenge or block high-risk traffic when you are ready.
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
        <h2 className="mb-10 text-center font-heading text-3xl font-bold tracking-tight">
          Risk scoring with boring primitives
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <Card key={feature.title}>
              <CardHeader>
                <CardTitle>{feature.title}</CardTitle>
                <CardDescription>{feature.description}</CardDescription>
              </CardHeader>
            </Card>
          ))}
        </div>
      </section>

      {/* Quickstart */}
      <section className="mx-auto w-full max-w-3xl px-6 pb-24">
        <h2 className="mb-6 text-center font-heading text-3xl font-bold tracking-tight">
          Quickstart
        </h2>
        <CodeBlock code={QUICKSTART} lang="python" />
      </section>

      {/* Footer */}
      <footer className="mt-auto border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-col items-center justify-between gap-4 px-6 py-8 text-sm text-muted-foreground sm:flex-row">
          <span>© {new Date().getFullYear()} NoSkrap · MIT</span>
          <nav className="flex items-center gap-5">
            <Link href={DOCS_URL} className="hover:text-foreground">
              Documentation
            </Link>
            <a href={GITHUB_URL} className="hover:text-foreground">
              GitHub
            </a>
          </nav>
        </div>
      </footer>
    </main>
  );
}
