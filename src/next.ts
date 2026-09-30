import {
  type BotResult,
  type NoSkrapConfig,
  type TelemetryResult,
  BotStorageError,
  createChallengePassHeaders,
  recordTelemetry,
  scoreRequest,
  validateConfig,
} from "./core.js";
import { CONTEXT_HEADER, readContext, signContext } from "./context.js";

export type NoSkrapObservation = Pick<
  BotResult,
  "decision" | "score" | "reasons" | "challengePassed" | "scoringAvailable"
>;

export interface NoSkrapProxyConfig extends NoSkrapConfig {
  // Exact paths only. Keep verification and abuse limits in these handlers.
  recoveryRoutes?: string[];
  onDecision?: (
    result: NoSkrapObservation,
    request: Request,
  ) => void | Promise<void>;
}

export interface NoSkrapTelemetryConfig extends NoSkrapConfig {
  verifyTelemetry: (
    request: Request,
    payload: { interacted: boolean },
    rawBody: Uint8Array,
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
): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();

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
  return buffer;
}

export async function getNoSkrapDecision(
  request: Request,
  config: NoSkrapConfig,
): Promise<BotResult> {
  validateConfig(config);
  return (await readContext(request, config)) ?? scoreRequest(request, config);
}

export function createNoSkrapProxy(config: NoSkrapProxyConfig) {
  validateConfig(config);
  if (config.recoveryRoutes?.some(path =>
    typeof path !== "string" || !path.startsWith("/") ||
    path.startsWith("//") || /[?#\\]/.test(path)
  )) {
    throw new TypeError("recoveryRoutes must contain absolute URL paths");
  }
  return async function noSkrapProxy(
    request: Request,
  ): Promise<Response> {
    const { NextResponse } = await import("next/server");
    const pathname = new URL(request.url).pathname;
    if (config.recoveryRoutes?.some(path => samePath(pathname, path))) {
      const headers = new Headers(request.headers);
      headers.delete(CONTEXT_HEADER);
      return NextResponse.next({ request: { headers } });
    }
    const decision = await scoreRequest(request, config);
    if (config.onDecision) {
      try {
        const { score, reasons, challengePassed, scoringAvailable } = decision;
        await config.onDecision(
          {
            decision: decision.decision,
            score,
            reasons,
            challengePassed,
            scoringAvailable,
          },
          request,
        );
      } catch (error) {
        console.error("NoSkrap onDecision failed", error);
      }
    }
    const failureMode = config.storageFailureMode ??
      (config.mode === "enforce" ? "closed" : "open");
    if (!decision.scoringAvailable && failureMode === "closed") {
      return Response.json({ error: "scoring unavailable" }, {
        status: 503, headers: decision.headers,
      });
    }

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
      redirectUrl.searchParams.set("next", safeReturnTarget(request.url));
      if (!isNavigation(request)) {
        return Response.json({
          error: "challenge required", challengeUrl: redirectUrl.href,
        }, { status: 403, headers: decision.headers });
      }
      const response = NextResponse.redirect(redirectUrl, {
        status: request.method === "GET" || request.method === "HEAD" ? 307 : 303,
      });
      copySetCookie(decision.headers, response.headers);
      return response;
    }

    const headers = new Headers(request.headers);
    headers.set(CONTEXT_HEADER, await signContext(request, decision, config));
    const visitorCookie = decision.headers.get("set-cookie")!.split(";")[0];
    const otherCookies = (headers.get("cookie") ?? "").split(";").filter(part =>
      !part.trim().startsWith("noskrap_visitor=") && part.trim()
    );
    headers.set("cookie", [...otherCookies, visitorCookie].join("; "));
    const response = NextResponse.next({ request: { headers } });
    copySetCookie(decision.headers, response.headers);
    return response;
  };
}

export function createNoSkrapTelemetryHandler(config: NoSkrapTelemetryConfig) {
  validateConfig(config);
  if (typeof config.verifyTelemetry !== "function") {
    throw new TypeError("verifyTelemetry must be a function");
  }

  return async function noSkrapTelemetry(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405, headers: { allow: "POST" },
      });
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
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return Response.json({ error: "invalid payload" }, { status: 400 });
    }
    if (!isTelemetryPayload(parsed)) {
      return Response.json({ error: "invalid payload" }, { status: 400 });
    }

    const payload = { interacted: parsed.interacted };
    if (!(await config.verifyTelemetry(request, payload, raw))) {
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    let result: TelemetryResult;
    try {
      result = await recordTelemetry(request, config, payload);
    } catch (error) {
      if (!(error instanceof BotStorageError)) throw error;
      return Response.json({ error: "telemetry unavailable" }, { status: 503 });
    }

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
  validateConfig(config);
  if (typeof config.verifyChallenge !== "function") {
    throw new TypeError("verifyChallenge must be a function");
  }

  return async function noSkrapChallengePass(
    request: Request,
  ): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405, headers: { allow: "POST" },
      });
    }
    if (!(await config.verifyChallenge(request))) {
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
  return path.replace(/\/+$/, "") || "/";
}

function isNavigation(request: Request): boolean {
  const mode = request.headers.get("sec-fetch-mode");
  if (mode) return mode === "navigate";
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/html") ||
    ((request.method === "GET" || request.method === "HEAD") &&
      !accept.includes("application/json"));
}

// The challenge page gets this back as `next` and will redirect to it, so it
// must stay same-origin whatever path the client asked for: a request path of
// `//evil.com/x` is protocol-relative and would leave the site. One leading
// slash keeps it a plain absolute path. The query is part of what the visitor
// asked for; the hash never reaches the server.
function safeReturnTarget(requestUrl: string): string {
  const { pathname, search } = new URL(requestUrl);
  return `/${pathname.replace(/^\/+/, "")}${search}`;
}

function copySetCookie(from: Headers, to: Headers): void {
  const cookie = from.get("set-cookie");
  if (cookie) to.append("set-cookie", cookie);
}
