export interface NavItem {
  title: string;
  href: string;
}

export interface NavSection {
  title?: string;
  items: NavItem[];
}

export const NAV: NavSection[] = [
  { items: [{ title: "Home", href: "/docs" }] },
  {
    title: "Getting Started",
    items: [
      { title: "Installation", href: "/docs/getting-started/installation" },
      { title: "Quickstart", href: "/docs/getting-started/quickstart" },
    ],
  },
  {
    title: "User Guide",
    items: [
      { title: "Next Proxy", href: "/docs/user-guide/next-proxy" },
      { title: "Route Handlers", href: "/docs/user-guide/route-handlers" },
      { title: "Telemetry", href: "/docs/user-guide/telemetry" },
      { title: "Challenge Pass", href: "/docs/user-guide/challenge-pass" },
      { title: "Client Popup", href: "/docs/user-guide/client-popup" },
    ],
  },
  {
    title: "Reference",
    items: [
      { title: "API Reference", href: "/docs/api-reference" },
      { title: "Development", href: "/docs/development" },
    ],
  },
];

// Every doc slug derived from the nav (["/docs"] -> []).
export function getDocSlugs(): string[][] {
  return NAV.flatMap((section) =>
    section.items.map((item) =>
      item.href.replace(/^\/docs\/?/, "").split("/").filter(Boolean),
    ),
  );
}
