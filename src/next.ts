import {
  type BotResult,
  type NoSkrapConfig,
  createChallengePassHeaders,
  recordTelemetry,
  scoreRequest,
} from "./core.js";

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

export function createNoSkrapTelemetryHandler(config: NoSkrapConfig) {
  return async function noSkrapTelemetry(request: Request): Promise<Response> {
    const payload = await request.json().catch(() => ({}));
    const result = await recordTelemetry(request, config, {
      pageView: payload?.pageView === true,
      interacted: payload?.interacted === true,
    });

    return Response.json(
      { ok: true },
      {
        headers: result.headers,
      },
    );
  };
}

export function createNoSkrapChallengePassHandler(config: NoSkrapConfig) {
  return async function noSkrapChallengePass(
    request: Request,
  ): Promise<Response> {
    return Response.json(
      { ok: true },
      {
        headers: await createChallengePassHeaders(request, config),
      },
    );
  };
}

function copySetCookie(from: Headers, to: Headers): void {
  const cookie = from.get("set-cookie");
  if (cookie) to.append("set-cookie", cookie);
}
