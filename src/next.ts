import {
  type BotResult,
  type NoSkrapConfig,
  createChallengePassHeaders,
  recordTelemetry,
  scoreRequest,
} from "./core.js";

export type NoSkrapObservation = Pick<
  BotResult,
  "decision" | "score" | "reasons" | "challengePassed"
>;

export interface NoSkrapProxyConfig extends NoSkrapConfig {
  onDecision?: (
    result: NoSkrapObservation,
    request: Request,
  ) => void | Promise<void>;
}

export interface NoSkrapTelemetryConfig extends NoSkrapConfig {
  verifyTelemetry: (
    request: Request,
    payload: { interacted: boolean },
  ) => boolean | Promise<boolean>;
}

export interface NoSkrapChallengePassConfig extends NoSkrapConfig {
  verifyChallenge: (request: Request) => boolean | Promise<boolean>;
}

export async function getNoSkrapDecision(
  request: Request,
  config: NoSkrapConfig,
): Promise<BotResult> {
  return scoreRequest(request, config);
}

export function createNoSkrapProxy(config: NoSkrapProxyConfig) {
  return async function noSkrapProxy(
    request: Request,
  ): Promise<Response | undefined> {
    const decision = await scoreRequest(request, config);
    if (config.onDecision) {
      try {
        const { score, reasons, challengePassed } = decision;
        await config.onDecision(
          {
            decision: decision.decision,
            score,
            reasons,
            challengePassed,
          },
          request,
        );
      } catch (error) {
        console.error("NoSkrap onDecision failed", error);
      }
    }
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

export function createNoSkrapTelemetryHandler(config: NoSkrapTelemetryConfig) {
  if (typeof config.verifyTelemetry !== "function") {
    throw new TypeError("verifyTelemetry must be a function");
  }

  return async function noSkrapTelemetry(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 1024) {
      return new Response("Payload Too Large", { status: 413 });
    }

    const body = await request.json().catch(() => null);
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.interacted !== "boolean"
    ) {
      return Response.json({ error: "invalid payload" }, { status: 400 });
    }

    const payload = { interacted: body.interacted };
    if (!(await config.verifyTelemetry(request, payload))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const result = await recordTelemetry(request, config, payload);

    return Response.json(
      { ok: true },
      {
        headers: result.headers,
      },
    );
  };
}

export function createNoSkrapChallengePassHandler(
  config: NoSkrapChallengePassConfig,
) {
  if (typeof config.verifyChallenge !== "function") {
    throw new TypeError("verifyChallenge must be a function");
  }

  return async function noSkrapChallengePass(
    request: Request,
  ): Promise<Response> {
    if (
      request.method !== "POST" ||
      !(await config.verifyChallenge(request))
    ) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    const headers = await createChallengePassHeaders(request, config);
    if (!headers) {
      return Response.json(
        { error: "visitor cookie required" },
        { status: 401 },
      );
    }

    return Response.json(
      { ok: true },
      {
        headers,
      },
    );
  };
}

function copySetCookie(from: Headers, to: Headers): void {
  const cookie = from.get("set-cookie");
  if (cookie) to.append("set-cookie", cookie);
}
