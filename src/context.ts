import {
  type BotResult,
  type NoSkrapConfig,
  signVisitorToken,
  verifyVisitorToken,
} from "./core.js";

export const CONTEXT_HEADER = "x-noskrap-context";
const CONTEXT_TTL_MS = 30_000;

interface RequestContext {
  id: string;
  kind: "noskrap-request";
  method: string;
  urlHash: string;
  expiresAt: number;
  cookie: string;
  result: Omit<BotResult, "headers" | "visitorId">;
}

export async function signContext(
  request: Request,
  result: BotResult,
  config: NoSkrapConfig,
): Promise<string> {
  const { headers, visitorId, ...observation } = result;
  const context: RequestContext = {
    id: visitorId,
    kind: "noskrap-request",
    method: request.method,
    urlHash: await hashUrl(request.url),
    expiresAt: (config.now?.() ?? Date.now()) + CONTEXT_TTL_MS,
    cookie: headers.get("set-cookie")!,
    result: observation,
  };
  const secret = Array.isArray(config.secret) ? config.secret[0] : config.secret;
  return signVisitorToken(context, secret);
}

export async function readContext(
  request: Request,
  config: NoSkrapConfig,
): Promise<BotResult | null> {
  const token = request.headers.get(CONTEXT_HEADER);
  if (!token || token.length > 8192) return null;
  const value: unknown = await verifyVisitorToken(token, config.secret);
  if (!isContext(value)) return null;
  const now = config.now?.() ?? Date.now();
  if (
    value.method !== request.method || value.urlHash !== await hashUrl(request.url) ||
    value.expiresAt <= now || value.expiresAt > now + CONTEXT_TTL_MS
  ) return null;
  const visitorCookie = value.cookie.split(";")[0];
  if (!request.headers.get("cookie")?.split(";").some(part => part.trim() === visitorCookie)) {
    return null;
  }
  return {
    ...value.result,
    visitorId: value.id,
    headers: new Headers({ "set-cookie": value.cookie }),
  };
}

function isContext(value: unknown): value is RequestContext {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "noskrap-request" || typeof record.id !== "string" ||
    typeof record.method !== "string" || typeof record.urlHash !== "string" ||
    typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt) ||
    typeof record.cookie !== "string" || !record.cookie.startsWith("noskrap_visitor=") ||
    /[\r\n]/.test(record.cookie) || typeof record.result !== "object" || record.result === null
  ) return false;
  const result = record.result as Record<string, unknown>;
  return typeof result.decision === "string" &&
    ["allow", "observe", "challenge", "block"].includes(result.decision) &&
    typeof result.score === "number" && Number.isFinite(result.score) &&
    result.score >= 0 && result.score <= 100 &&
    typeof result.challengePassed === "boolean" && typeof result.scoringAvailable === "boolean" &&
    Array.isArray(result.reasons) && result.reasons.every(isReason);
}

function isReason(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const reason = value as Record<string, unknown>;
  return typeof reason.ruleId === "string" && typeof reason.score === "number" &&
    Number.isFinite(reason.score) && reason.score >= 0;
}

async function hashUrl(url: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
