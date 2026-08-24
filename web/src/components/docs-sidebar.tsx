"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV } from "@/lib/docs-nav";
import { cn } from "@/lib/utils";

// `trailingSlash: true` makes usePathname return "/docs/x/", so compare on a
// slash-free form instead of the raw nav href.
function normalize(pathname: string): string {
  return pathname.replace(/\/+$/, "") || "/";
}

export function DocsSidebar() {
  const pathname = normalize(usePathname());

  return (
    <nav className="flex flex-col gap-6 text-sm">
      {NAV.map((section, i) => (
        <div key={section.title ?? i} className="flex flex-col gap-1">
          {section.title && (
            <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {section.title}
            </p>
          )}
          {section.items.map((item) => {
            const active = pathname === normalize(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-2 py-1.5 transition-colors",
                  active
                    ? "bg-accent font-medium text-foreground"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                {item.title}
              </Link>
            );
          })}
        </div>
      ))}
    </nav>
  );
}
