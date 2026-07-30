export type BotDecision = "allow" | "observe" | "challenge" | "block";

export interface BotReason {
  ruleId: string;
  score: number;
}

export interface VisitorState {
  id: string;
  lastSeen: number;
  lastInteractionAt?: number;
}

export interface BotStorage {
  getVisitor(id: string): Promise<VisitorState | null>;
  setVisitor(
    id: string,
    state: VisitorState,
    ttlSeconds: number,
  ): Promise<void>;
  incrementCounter(key: string, windowSeconds: number): Promise<number>;
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
  challengeTtlSeconds?: number;
  getClientIp?: (request: Request) => string | null | undefined;
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
  challengePassed: boolean;
  headers: Headers;
}

export interface TelemetryPayload {
  interacted: boolean;
}

const DEFAULT_THRESHOLDS = { observe: 30, challenge: 60, block: 85 };
const VISITOR_COOKIE = "noskrap_visitor";
const CHALLENGE_COOKIE = "noskrap_challenge";
const VISITOR_TTL_SECONDS = 60 * 60 * 24 * 30;
const CHALLENGE_TTL_SECONDS = 10 * 60;
const RATE_WINDOW_SECONDS = 60;
const INTERACTION_TTL_MS = 10 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;
let defaultMemoryStorage: MemoryBotStorage | undefined;

export async function scoreRequest(
  request: Request,
  config: NoSkrapConfig,
): Promise<BotResult> {
  validateConfig(config);
  const now = config.now?.() ?? Date.now();
  const storage = config.storage ?? getDefaultStorage();
  const thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;
  const token = getCookie(request, VISITOR_COOKIE);
  const tokenPayload = token
    ? await verifyVisitorToken(token, config.secret)
    : null;
  const visitorId = tokenPayload?.id ?? createId();
  const existing = await storage.getVisitor(visitorId);
  const visitor: VisitorState = {
    id: visitorId,
    lastSeen: now,
    lastInteractionAt: existing?.lastInteractionAt,
  };

  const reasons: BotReason[] = [];
  const addReason = (ruleId: string, score: number) => {
    const configuredScore = ruleScore(config, ruleId, score);
    if (configuredScore > 0) reasons.push({ ruleId, score: configuredScore });
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

  if (!tokenPayload && existing === null && isProtected) {
    addReason("behavior.noCookieContinuity", 15);
  }

  if (
    isProtected &&
    isUnsafeMethod(request.method) &&
    (!visitor.lastInteractionAt ||
      now - visitor.lastInteractionAt > INTERACTION_TTL_MS)
  ) {
    addReason("behavior.noRecentInteraction", 30);
  }

  const ip = config.getClientIp?.(request)?.trim();
  const ipCount = ip
    ? await storage.incrementCounter(
        `ip:${ip}:${url.pathname}`,
        RATE_WINDOW_SECONDS,
      )
    : 0;
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
  await storage.setVisitor(visitorId, visitor, VISITOR_TTL_SECONDS);

  const signedToken = await signVisitorToken(
    { id: visitorId },
    firstSecret(config.secret),
  );
  const responseHeaders = new Headers();
  responseHeaders.append(
    "set-cookie",
    `${VISITOR_COOKIE}=${signedToken}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${VISITOR_TTL_SECONDS}`,
  );
  const decision = decisionForScore(score, thresholds);
  const challengePassed =
    decision === "challenge" && await verifyChallengePass(request, config);

  return {
    decision: challengePassed ? "allow" : decision,
    score,
    reasons,
    visitorId,
    challengePassed,
    headers: responseHeaders,
  };
}

export async function recordTelemetry(
  request: Request,
  config: NoSkrapConfig,
  payload: TelemetryPayload,
): Promise<BotResult> {
  const result = await scoreRequest(request, config);
  const now = config.now?.() ?? Date.now();
  const storage = config.storage ?? getDefaultStorage();
  const existing = await storage.getVisitor(result.visitorId);

  await storage.setVisitor(
    result.visitorId,
    {
      id: result.visitorId,
      lastSeen: now,
      lastInteractionAt: payload.interacted
        ? now
        : existing?.lastInteractionAt,
    },
    VISITOR_TTL_SECONDS,
  );

  return result;
}

export async function createChallengePassHeaders(
  request: Request,
  config: NoSkrapConfig,
): Promise<Headers | null> {
  validateConfig(config);
  const visitorToken = getCookie(request, VISITOR_COOKIE);
  const visitor = visitorToken
    ? await verifyVisitorToken(visitorToken, config.secret)
    : null;
  if (!visitor) return null;

  const now = config.now?.() ?? Date.now();
  const maxAge = config.challengeTtlSeconds ?? CHALLENGE_TTL_SECONDS;
  const token = await signChallengePassToken(
    {
      id: visitor.id,
      expiresAt: now + maxAge * 1000,
    },
    firstSecret(config.secret),
  );

  const headers = new Headers();
  headers.append(
    "set-cookie",
    `${CHALLENGE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`,
  );
  return headers;
}

export async function verifyChallengePass(
  request: Request,
  config: NoSkrapConfig,
): Promise<boolean> {
  validateConfig(config);
  const visitorToken = getCookie(request, VISITOR_COOKIE);
  const challengeToken = getCookie(request, CHALLENGE_COOKIE);
  if (!visitorToken || !challengeToken) return false;

  const visitor = await verifyVisitorToken(visitorToken, config.secret);
  const challenge = await verifyChallengePassToken(challengeToken, config.secret);
  const now = config.now?.() ?? Date.now();

  return Boolean(
    visitor &&
      challenge &&
      challenge.id === visitor.id &&
      challenge.expiresAt > now,
  );
}

export class MemoryBotStorage implements BotStorage {
  private visitors = new Map<
    string,
    { value: VisitorState; expiresAt: number }
  >();
  private counters = new Map<string, { value: number; expiresAt: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries = 10_000,
  ) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new TypeError("maxEntries must be a positive integer");
    }
  }

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
    this.makeRoom(this.visitors, id);
    this.visitors.set(id, {
      value: state,
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async incrementCounter(key: string, windowSeconds: number): Promise<number> {
    const existing = this.counters.get(key);
    if (!existing || existing.expiresAt <= this.now()) {
      this.makeRoom(this.counters, key);
      this.counters.set(key, {
        value: 1,
        expiresAt: this.now() + windowSeconds * 1000,
      });
      return 1;
    }
    existing.value += 1;
    return existing.value;
  }

  private makeRoom<T extends { expiresAt: number }>(
    map: Map<string, T>,
    nextKey: string,
  ): void {
    if (map.has(nextKey) || map.size < this.maxEntries) return;

    const now = this.now();
    for (const [key, entry] of map) {
      if (entry.expiresAt <= now) map.delete(key);
    }

    if (map.size >= this.maxEntries) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) map.delete(oldestKey);
    }
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
  payload: { id: string },
  secret: string,
): Promise<string> {
  validateSecrets(secret);
  if (!payload.id) throw new TypeError("visitor id is required");
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(body, secret);
  return `${body}.${signature}`;
}

export async function verifyVisitorToken(
  token: string,
  secrets: string | string[],
): Promise<{ id: string } | null> {
  validateSecrets(secrets);
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  for (const secret of Array.isArray(secrets) ? secrets : [secrets]) {
    if (await verifyHmac(body, signature, secret)) {
      try {
        const payload = JSON.parse(base64UrlDecode(body));
        if (typeof payload.id === "string" && payload.id.length > 0) {
          return payload;
        }
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function signChallengePassToken(
  payload: { id: string; expiresAt: number },
  secret: string,
): Promise<string> {
  const body = base64UrlEncode(JSON.stringify(payload));
  const signature = await hmac(body, secret);
  return `${body}.${signature}`;
}

async function verifyChallengePassToken(
  token: string,
  secrets: string | string[],
): Promise<{ id: string; expiresAt: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  if (!body || !signature) return null;

  for (const secret of Array.isArray(secrets) ? secrets : [secrets]) {
    if (await verifyHmac(body, signature, secret)) {
      try {
        const payload = JSON.parse(base64UrlDecode(body));
        if (
          typeof payload.id === "string" &&
          typeof payload.expiresAt === "number"
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

function validateConfig(config: NoSkrapConfig): void {
  validateSecrets(config.secret);
  if (
    config.mode !== undefined &&
    !["observe", "enforce"].includes(config.mode)
  ) {
    throw new TypeError('mode must be "observe" or "enforce"');
  }

  if (
    config.getClientIp !== undefined &&
    typeof config.getClientIp !== "function"
  ) {
    throw new TypeError("getClientIp must be a function");
  }

  const thresholds = config.thresholds ?? DEFAULT_THRESHOLDS;
  if (
    ![thresholds.observe, thresholds.challenge, thresholds.block].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 100,
    ) ||
    thresholds.observe > thresholds.challenge ||
    thresholds.challenge > thresholds.block
  ) {
    throw new TypeError(
      "thresholds must be ordered numbers between 0 and 100",
    );
  }

  if (
    config.challengeTtlSeconds !== undefined &&
    (!Number.isInteger(config.challengeTtlSeconds) ||
      config.challengeTtlSeconds < 1)
  ) {
    throw new TypeError("challengeTtlSeconds must be a positive integer");
  }

  for (const rule of config.rules ?? []) {
    if (
      typeof rule.id !== "string" ||
      rule.id.length === 0 ||
      (rule.score !== undefined &&
        (!Number.isFinite(rule.score) || rule.score < 0))
    ) {
      throw new TypeError("rules require an id and a non-negative score");
    }
  }
}

function validateSecrets(secret: string | string[]): void {
  const secrets = Array.isArray(secret) ? secret : [secret];
  if (
    secrets.length === 0 ||
    secrets.some(
      (secret) =>
        typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH,
    )
  ) {
    throw new TypeError(
      `secret must contain at least ${MIN_SECRET_LENGTH} characters`,
    );
  }
}

function createId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return `v_${base64UrlEncode(String.fromCharCode(...bytes))}`;
}

async function hmac(value: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await importHmacKey(secret),
    new TextEncoder().encode(value),
  );
  return base64UrlEncode(String.fromCharCode(...new Uint8Array(signature)));
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function verifyHmac(
  value: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  try {
    const bytes = Uint8Array.from(
      base64UrlDecode(signature),
      (character) => character.charCodeAt(0),
    );
    return crypto.subtle.verify(
      "HMAC",
      await importHmacKey(secret),
      bytes,
      new TextEncoder().encode(value),
    );
  } catch {
    return false;
  }
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
