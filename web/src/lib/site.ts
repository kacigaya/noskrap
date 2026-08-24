// Canonical production origin, including the GitHub Pages base path. Metadata
// URLs must stay absolute and stable regardless of which base path a given
// build uses, so this is deliberately not derived from NEXT_PUBLIC_BASE_PATH.
export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://kacigaya.github.io/noskrap";

export const SITE_NAME = "NoSkrap";

export const SITE_DESCRIPTION =
  "NoSkrap scores Next.js requests with explainable bot-risk signals, signed visitor continuity, interaction telemetry, challenge passes, and enforce-mode redirects.";
