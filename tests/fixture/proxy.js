import { createNoSkrapProxy } from "noskrap/next";
import { config as shared } from "./shared.js";
export const config = { matcher: ["/api/:path*", "/alias", "/bot-check"] };
export const proxy = createNoSkrapProxy({
  ...shared, mode: "enforce", challengePath: "/bot-check",
  rewrite: request => {
    if (new URL(request.url).pathname !== "/alias") return null;
    return new URL(`/api/check${new URL(request.url).search}`, request.url);
  },
  recoveryRoutes: ["/api/noskrap/telemetry", "/api/noskrap/challenge-pass"],
});
