import { createNoSkrapProxy } from "noskrap/next";
import { config as shared } from "./shared.js";
export const config = { matcher: ["/api/:path*", "/bot-check"] };
export const proxy = createNoSkrapProxy({
  ...shared, mode: "enforce", challengePath: "/bot-check",
  recoveryRoutes: ["/api/noskrap/telemetry", "/api/noskrap/challenge-pass"],
});
