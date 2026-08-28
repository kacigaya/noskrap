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

const MAX_TELEMETRY_BYTES = 1024;

function isTelemetryPayload(value: unknown): value is { interacted: boolean } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).interacted === "boolean"
  );
}

// `content-length` is client-supplied and absent entirely on chunked requests,
// so it cannot be the only guard. Read the stream and give up once the cap is
// passed, rather than buffering whatever the client decides to send.
async function readBodyWithLimit(
  request: Request,
  limit: number,
): Promise<string | null> {
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(buffer);
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

    // The challenge page usually sits inside the proxy matcher, so redirecting
    // a challenged visitor who is already on it would loop forever and they
    // could never solve the challenge.
    if (
      config.mode === "enforce" &&
      decision.decision === "challenge" &&
      config.challengePath &&
      !samePath(
        new URL(request.url).pathname,
        new URL(config.challengePath, request.url).pathname,
      )
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

    // Fast path for clients that honestly declare an oversized body.
    const contentLength = Number(request.headers.get("content-length"));
    if (contentLength > MAX_TELEMETRY_BYTES) {
      return new Response("Payload Too Large", { status: 413 });
    }

    const raw = await readBodyWithLimit(request, MAX_TELEMETRY_BYTES);
    if (raw === null) {
      return new Response("Payload Too Large", { status: 413 });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return Response.json({ error: "invalid payload" }, { status: 400 });
    }
    if (!isTelemetryPayload(parsed)) {
      return Response.json({ error: "invalid payload" }, { status: 400 });
    }

    const payload = { interacted: parsed.interacted };
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

// Next.js serves a route with or without a trailing slash depending on
// `trailingSlash`, so both spellings have to compare equal.
function samePath(a: string, b: string): boolean {
  return stripTrailingSlash(a) === stripTrailingSlash(b);
}

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function copySetCookie(from: Headers, to: Headers): void {
  const cookie = from.get("set-cookie");
  if (cookie) to.append("set-cookie", cookie);
}
