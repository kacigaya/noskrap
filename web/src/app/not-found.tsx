import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export const metadata: Metadata = {
  title: "Page not found",
  // Next already emits `noindex` here; inheriting the root canonical would
  // point every missing URL at the homepage.
  alternates: { canonical: null },
};

// GitHub Pages serves out/404.html for every unmatched path, so this is the
// page visitors land on after a renamed or mistyped docs URL.
export default function NotFound() {
  return (
    <main className="flex min-h-full flex-1 flex-col items-center justify-center px-6 py-24 text-center">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="mt-4 font-heading text-4xl font-bold tracking-tight">
        This page does not exist
      </h1>
      <p className="mt-4 max-w-md text-muted-foreground">
        The page may have been renamed or moved. The documentation index lists
        everything that is still here.
      </p>
      <div className="mt-10 flex flex-col gap-3 sm:flex-row">
        <Button render={<Link href="/docs" />}>Browse the docs</Button>
        <Button variant="outline" render={<Link href="/" />}>
          Go home
        </Button>
      </div>
    </main>
  );
}
