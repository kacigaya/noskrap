import { withDeadline, validateDeadline } from "./deadline.js";
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
  // Resolve routing before scoring so context is bound to the destination.
  rewrite?: (request: Request) => URL | null;
  onDecisionTimeoutMs?: number;
  onDecision?: (
    result: NoSkrapObservation,
    request: Request,
    signal: AbortSignal,
  ) => void | Promise<void>;
}

export interface NoSkrapTelemetryConfig extends NoSkrapConfig {
  verificationTimeoutMs?: number;
  verifyTelemetry: (
    request: Request,
    payload: { interacted: boolean },
    rawBody: Uint8Array,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;
}

export interface NoSkrapChallengePassConfig extends NoSkrapConfig {
  verificationTimeoutMs?: number;
  verifyChallenge: (request: Request, signal: AbortSignal) => boolean | Promise<boolean>;
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
  signal: AbortSignal,
): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array();

  signal.throwIfAborted();
  const reader = request.body.getReader();
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
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
  validateDeadline(config.onDecisionTimeoutMs, "onDecisionTimeoutMs");
  if (config.rewrite !== undefined && typeof config.rewrite !== "function") throw new TypeError("rewrite must be a function");
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
    const destination = config.rewrite?.(request);
    if (destination && (destination.origin !== new URL(request.url).origin || destination.hash)) {
      throw new TypeError("rewrite must return a same-origin URL without a fragment");
    }
    const scoredRequest = destination ? new Request(destination, {
      method: request.method, headers: request.headers, signal: request.signal,
    }) : request;
    // Next.js may run the proxy again after an internal rewrite. Only a
    // verified rewrite context bound to this destination can skip scoring.
    const reused = config.rewrite && !destination
      ? await readContext(scoredRequest, config, true) : null;
    const decision = reused ?? await scoreRequest(scoredRequest, config);
    if (config.onDecision && !reused) {
      try {
        const { score, reasons, challengePassed, scoringAvailable } = decision;
        const onDecision = config.onDecision;
        await withDeadline(signal => onDecision(
          {
            decision: decision.decision,
            score,
            reasons,
            challengePassed,
            scoringAvailable,
          },
          request, signal,
        ), config.onDecisionTimeoutMs ?? 1000, request.signal);
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
    headers.set(CONTEXT_HEADER, await signContext(scoredRequest, decision, config, Boolean(destination)));
    const visitorCookie = decision.headers.get("set-cookie")!.split(";")[0];
    const otherCookies = (headers.get("cookie") ?? "").split(";").filter(part =>
      !part.trim().startsWith("noskrap_visitor=") && part.trim()
    );
    headers.set("cookie", [...otherCookies, visitorCookie].join("; "));
    const response = destination
      ? NextResponse.rewrite(destination, { request: { headers } })
      : NextResponse.next({ request: { headers } });
    copySetCookie(decision.headers, response.headers);
    return response;
  };
}

export function createNoSkrapTelemetryHandler(config: NoSkrapTelemetryConfig) {
  validateConfig(config);
  validateDeadline(config.verificationTimeoutMs, "verificationTimeoutMs");
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

    let raw: Uint8Array | null;
    try {
      raw = await withDeadline(signal => readBodyWithLimit(request, MAX_TELEMETRY_BYTES, signal),
        config.verificationTimeoutMs ?? 5000, request.signal);
    } catch {
      return Response.json({ error: "body unavailable" }, { status: 408 });
    }
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
    let verified: boolean;
    try {
      verified = await withDeadline(signal => config.verifyTelemetry(request, payload, raw, signal),
        config.verificationTimeoutMs ?? 5000, request.signal);
    } catch {
      return Response.json({ error: "verification unavailable" }, { status: 503 });
    }
    if (verified !== true) {
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
  validateDeadline(config.verificationTimeoutMs, "verificationTimeoutMs");
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
    let verified: boolean;
    try {
      verified = await withDeadline(signal => config.verifyChallenge(request, signal),
        config.verificationTimeoutMs ?? 5000, request.signal);
    } catch {
      return Response.json({ error: "verification unavailable" }, { status: 503 });
    }
    if (verified !== true) {
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
