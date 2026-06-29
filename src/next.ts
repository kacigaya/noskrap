import { type BotResult, type NoSkrapConfig, scoreRequest } from "./core.js";

export async function getNoSkrapDecision(
  request: Request,
  config: NoSkrapConfig,
): Promise<BotResult> {
  return scoreRequest(request, config);
}

export function createNoSkrapProxy(config: NoSkrapConfig) {
  return async function noSkrapProxy(
    request: Request,
  ): Promise<Response | undefined> {
    const decision = await scoreRequest(request, config);
    const { NextResponse } = await import("next/server");

    if (config.mode === "enforce" && decision.decision === "block") {
      return new Response("Forbidden", {
        status: 403,
        headers: decision.headers,
      });
    }

    if (
      config.mode === "enforce" &&
      decision.decision === "challenge" &&
      config.challengePath
    ) {
      const redirectUrl = new URL(config.challengePath, request.url);
      redirectUrl.searchParams.set("next", new URL(request.url).pathname);
      const response = NextResponse.redirect(redirectUrl);
      copySetCookie(decision.headers, response.headers);
      return response;
    }

    const response = NextResponse.next();
    copySetCookie(decision.headers, response.headers);
    return response;
  };
}

function copySetCookie(from: Headers, to: Headers): void {
  const cookie = from.get("set-cookie");
  if (cookie) to.append("set-cookie", cookie);
}
