export type BotDecision = "allow" | "observe" | "challenge" | "block";

export interface BotReason {
  ruleId: string;
  score: number;
}

export interface VisitorState {
  id: string;
  firstSeen: number;
  lastSeen: number;
  rollingRisk: number;
}

export interface BotStorage {
  getVisitor(id: string): Promise<VisitorState | null>;
  setVisitor(
    id: string,
    state: VisitorState,
    ttlSeconds: number,
  ): Promise<void>;
  incrementCounter(key: string, windowSeconds: number): Promise<number>;
  putNonce(key: string, ttlSeconds: number): Promise<boolean>;
}

export interface RuleConfig {
  id: string;
  enabled?: boolean;
  score?: number;
}

export interface NoSkrapConfig {
  secret: string | string[];
  mode?: "observe" | "enforce";
  protectedRoutes?: string[];
  challengePath?: string;
  trustedProxies?: string[];
  storage?: BotStorage;
  thresholds?: {
    observe: number;
    challenge: number;
    block: number;
  };
  rules?: RuleConfig[];
  now?: () => number;
}

export interface BotResult {
  decision: BotDecision;
  score: number;
  reasons: BotReason[];
  visitorId: string;
  headers: Headers;
}

const DEFAULT_THRESHOLDS = { observe: 30, challenge: 60, block: 85 };
const VISITOR_COOKIE = "noskrap_visitor";
const VISITOR_TTL_SECONDS = 60 * 60 * 24 * 30;
const RATE_WINDOW_SECONDS = 60;
let defaultMemoryStorage: MemoryBotStorage | undefined;

export async function scoreRequest(
  request: Request,
  config: NoSkrapConfig,
): Promise<BotResult> {
  const now = config.now?.() ?? Date.now();
  const storage = config.storage ?? getDefaultStorage();
  const thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;
  const token = getCookie(request, VISITOR_COOKIE);
  const tokenPayload = token
    ? await verifyVisitorToken(token, config.secret)
    : null;
  const visitorId = tokenPayload?.id ?? createId();
  const existing = await storage.getVisitor(visitorId);
  const firstSeen = existing?.firstSeen ?? tokenPayload?.firstSeen ?? now;
  const visitor: VisitorState = {
    id: visitorId,
    firstSeen,
    lastSeen: now,
    rollingRisk: existing?.rollingRisk ?? 0,
  };

  const reasons: BotReason[] = [];
  const addReason = (ruleId: string, score: number) => {
    if (ruleScore(config, ruleId, score) > 0) {
      reasons.push({ ruleId, score: ruleScore(config, ruleId, score) });
    }
  };

  const url = new URL(request.url);
  const isProtected = matchesProtectedRoute(
    url.pathname,
    config.protectedRoutes,
  );
  const headers = request.headers;
  const userAgent = headers.get("user-agent") ?? "";
  const accept = headers.get("accept") ?? "";
  const acceptLanguage = headers.get("accept-language") ?? "";
  const secFetchMode = headers.get("sec-fetch-mode") ?? "";
  const secFetchSite = headers.get("sec-fetch-site") ?? "";
  const clientPlatform = headers.get("sec-ch-ua-platform") ?? "";

  if (isHtmlNavigation(request) && (!userAgent || !accept || !acceptLanguage)) {
    addReason("headers.missingBrowserHeaders", 25);
  }

  if (/HeadlessChrome|curl|wget|python-requests/i.test(userAgent)) {
    addReason("browser.automationUa", 30);
  }

  if (
    clientPlatform &&
    /Android|iPhone|iPad/i.test(userAgent) !==
      /Android|iOS/i.test(clientPlatform)
  ) {
    addReason("headers.uaClientHintsMismatch", 15);
  }

  if (
    isProtected &&
    isUnsafeMethod(request.method) &&
    (!secFetchMode || secFetchSite === "none")
  ) {
    addReason("headers.badFetchMetadata", 20);
  }

  if (!token && existing === null && isProtected) {
    addReason("behavior.noCookieContinuity", 15);
  }

  const ip = getClientIp(request, config.trustedProxies);
  const ipCount = await storage.incrementCounter(
    `ip:${ip}:${url.pathname}`,
    RATE_WINDOW_SECONDS,
  );
  const visitorCount = await storage.incrementCounter(
    `visitor:${visitorId}:${url.pathname}`,
    RATE_WINDOW_SECONDS,
  );
  if (ipCount > 60 || visitorCount > 30) {
    addReason("rate.routeBurst", 35);
  }

  const score = Math.min(
    100,
    reasons.reduce((sum, reason) => sum + reason.score, 0),
  );
  visitor.rollingRisk = Math.round((visitor.rollingRisk + score) / 2);
  await storage.setVisitor(visitorId, visitor, VISITOR_TTL_SECONDS);

  const signedToken = await signVisitorToken(
    {
      id: visitorId,
      firstSeen,
      lastSeen: now,
      rollingRisk: visitor.rollingRisk,
    },
    firstSecret(config.secret),
  );
  const responseHeaders = new Headers();
  responseHeaders.append(
    "set-cookie",
    `${VISITOR_COOKIE}=${signedToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${VISITOR_TTL_SECONDS}`,
  );

  return {
    decision: decisionForScore(score, thresholds),
    score,
    reasons,
    visitorId,
    headers: responseHeaders,
  };
}

export class MemoryBotStorage implements BotStorage {
  private visitors = new Map<
    string,
    { value: VisitorState; expiresAt: number }
  >();
  private counters = new Map<string, { value: number; expiresAt: number }>();
  private nonces = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async getVisitor(id: string): Promise<VisitorState | null> {
    const entry = this.visitors.get(id);
    if (!entry || entry.expiresAt <= this.now()) {
      this.visitors.delete(id);
      return null;
    }
    return entry.value;
  }

  async setVisitor(
    id: string,
    state: VisitorState,
    ttlSeconds: number,
  ): Promise<void> {
    this.visitors.set(id, {
      value: state,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async incrementCounter(key: string, windowSeconds: number): Promise<number> {
    const existing = this.counters.get(key);
    if (!existing || existing.expiresAt <= this.now()) {
      this.counters.set(key, {
        value: 1,
        expiresAt: this.now() + windowSeconds * 1000,
      });
      return 1;
    }
    existing.value += 1;
    return existing.value;
  }

  async putNonce(key: string, ttlSeconds: number): Promise<boolean> {
    const expiresAt = this.nonces.get(key);
    if (expiresAt && expiresAt > this.now()) {
      return false;
    }
    this.nonces.set(key, this.now() + ttlSeconds * 1000);
    return true;
  }
}

export function decisionForScore(
  score: number,
  thresholds = DEFAULT_THRESHOLDS,
): BotDecision {
  if (score >= thresholds.block) return "block";
  if (score >= thresholds.challenge) return "challenge";
  if (score >= thresholds.observe) return "observe";
  return "allow";
}

function getDefaultStorage(): MemoryBotStorage {
  defaultMemoryStorage ??= new MemoryBotStorage();
  return defaultMemoryStorage;
}

export async function signVisitorToken(
  payload: {
    id: string;
    firstSeen: number;
    lastSeen: number;
    rollingRisk: number;
  },
  secret: string,
): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(body, secret);
  return `${body}.${signature}`;
}

export async function verifyVisitorToken(
  token: string,
  secrets: string | string[],
): Promise<{
  id: string;
  firstSeen: number;
  lastSeen: number;
  rollingRisk: number;
} | null> {
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;

  for (const secret of Array.isArray(secrets) ? secrets : [secrets]) {
    if ((await hmac(body, secret)) === signature) {
      try {
        const payload = JSON.parse(base64UrlDecode(body));
        if (
          typeof payload.id === "string" &&
          typeof payload.firstSeen === "number"
        ) {
          return payload;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

function isHtmlNavigation(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  const mode = request.headers.get("sec-fetch-mode") ?? "";
  return (
    request.method === "GET" &&
    (accept.includes("text/html") || mode === "navigate")
  );
}

function isUnsafeMethod(method: string): boolean {
  return !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase());
}

function matchesProtectedRoute(
  pathname: string,
  protectedRoutes: string[] = [],
): boolean {
  return protectedRoutes.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

function getClientIp(request: Request, trustedProxies: string[] = []): string {
  if (trustedProxies.length === 0) return "unknown";
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

function getCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  const prefix = `${name}=`;
  return (
    cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(prefix))
      ?.slice(prefix.length) ?? null
  );
}

function ruleScore(
  config: NoSkrapConfig,
  ruleId: string,
  fallback: number,
): number {
  const rule = config.rules?.find((item) => item.id === ruleId);
  if (rule?.enabled === false) return 0;
  return rule?.score ?? fallback;
}

function firstSecret(secret: string | string[]): string {
  return Array.isArray(secret) ? secret[0] : secret;
}

function createId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `v_${base64UrlEncode(String.fromCharCode(...bytes))}`;
}

async function hmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}

function base64UrlEncode(value: string): string {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function base64UrlDecode(value: string): string {
  const padded = value.padEnd(
    value.length + ((4 - (value.length % 4)) % 4),
    "=",
  );
  return atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
}
