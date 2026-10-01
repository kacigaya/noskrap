import { withDeadline, validateDeadline } from "./deadline.js";

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
  getVisitor(id: string, signal?: AbortSignal): Promise<VisitorState | null>;
  // Atomically preserve the newest lastSeen/lastInteractionAt timestamps.
  setVisitor(
    id: string,
    state: VisitorState,
    ttlSeconds: number,
    signal?: AbortSignal,
  ): Promise<void>;
  incrementCounter(key: string, windowSeconds: number, signal?: AbortSignal): Promise<number>;
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
  storageTimeoutMs?: number;
  storageFailureMode?: "open" | "closed";
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
  scoringAvailable: boolean;
  headers: Headers;
}

export interface TelemetryResult {
  visitorId: string;
  headers: Headers;
}

export class BotStorageError extends Error {
  constructor(cause: unknown) {
    super("NoSkrap storage unavailable", { cause });
    this.name = "BotStorageError";
  }
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
let warnedAboutDefaultStorage = false;

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

  const reasons: BotReason[] = [];
  const addReason = (ruleId: string, score: number) => {
    const configuredScore = ruleScore(config, ruleId, score);
    if (configuredScore > 0) reasons.push({ ruleId, score: configuredScore });
  };

  const url = new URL(request.url);
  const protectedRoute = matchingProtectedRoute(
    url.pathname,
    config.protectedRoutes,
  );
  const isProtected = protectedRoute !== null;
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

  if (!tokenPayload && isProtected) {
    addReason("behavior.noCookieContinuity", 15);
  }

  const rateEnabled = ruleScore(config, "rate.routeBurst", 35) > 0;
  const interactionEnabled = ruleScore(config, "behavior.noRecentInteraction", 30) > 0;
  const ip = rateEnabled ? config.getClientIp?.(request)?.trim() : undefined;
  const routeKey = protectedRoute ?? "*";
  let scoringAvailable = true;
  try {
    const [existing, ipCount, visitorCount] = await storageOperation(
      signal => Promise.all([
        interactionEnabled && tokenPayload && isProtected && isUnsafeMethod(request.method)
          ? storage.getVisitor(visitorId, signal)
          : Promise.resolve(null),
        ip ? storage.incrementCounter(`ip:${ip}:${routeKey}`, RATE_WINDOW_SECONDS, signal) : Promise.resolve(0),
        rateEnabled && tokenPayload ? storage.incrementCounter(`visitor:${visitorId}:${routeKey}`, RATE_WINDOW_SECONDS, signal) : Promise.resolve(0),
      ]),
      config, request.signal,
    );
    const interaction = existing?.lastInteractionAt;
    if (
      interactionEnabled && isProtected && isUnsafeMethod(request.method) &&
      (interaction === undefined || interaction > now ||
        now - interaction >= INTERACTION_TTL_MS)
    ) {
      addReason("behavior.noRecentInteraction", 30);
    }
    if (ipCount > 60 || visitorCount > 30) addReason("rate.routeBurst", 35);
  } catch (error) {
    if (!(error instanceof BotStorageError)) throw error;
    scoringAvailable = false;
  }

  const score = Math.min(
    100,
    reasons.reduce((sum, reason) => sum + reason.score, 0),
  );
  const responseHeaders = await visitorHeaders(visitorId, config.secret);
  const decision = decisionForScore(score, thresholds);
  const challengePassed =
    decision === "challenge" && await verifyChallengePass(request, config);

  return {
    decision: challengePassed ? "allow" : decision,
    score,
    reasons,
    visitorId,
    challengePassed,
    scoringAvailable,
    headers: responseHeaders,
  };
}

export async function recordTelemetry(
  request: Request,
  config: NoSkrapConfig,
  payload: TelemetryPayload,
): Promise<TelemetryResult> {
  validateConfig(config);
  if (typeof payload.interacted !== "boolean") throw new TypeError("interacted must be a boolean");
  const token = getCookie(request, VISITOR_COOKIE);
  const visitor = token ? await verifyVisitorToken(token, config.secret) : null;
  const visitorId = visitor?.id ?? createId();
  const now = config.now?.() ?? Date.now();
  const storage = config.storage ?? getDefaultStorage();
  if (payload.interacted) {
    await storageOperation(signal => storage.setVisitor(
      visitorId,
      { id: visitorId, lastSeen: now, lastInteractionAt: now },
      INTERACTION_TTL_MS / 1000, signal,
    ), config, request.signal);
  }
  return { visitorId, headers: await visitorHeaders(visitorId, config.secret) };
}

async function visitorHeaders(visitorId: string, secret: string | string[]): Promise<Headers> {
  const token = await signVisitorToken({ id: visitorId }, firstSecret(secret));
  return new Headers({ "set-cookie": `${VISITOR_COOKIE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${VISITOR_TTL_SECONDS}` });
}

async function storageOperation<T>(operation: (signal: AbortSignal) => Promise<T>, config: NoSkrapConfig, signal: AbortSignal): Promise<T> {
  try {
    return await withDeadline(operation, config.storageTimeoutMs ?? 1000, signal);
  } catch (error) {
    throw new BotStorageError(error);
  }
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
  private sweepTimes = new WeakMap<object, number>();
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
    return { ...entry.value };
  }

  async setVisitor(
    id: string,
    state: VisitorState,
    ttlSeconds: number,
  ): Promise<void> {
    validateVisitorState(id, state, ttlSeconds);
    const previous = this.visitors.get(id);
    const existing = previous && previous.expiresAt > this.now() ? previous.value : undefined;
    const lastInteractionAt = Math.max(existing?.lastInteractionAt ?? -Infinity, state.lastInteractionAt ?? -Infinity);
    this.makeRoom(this.visitors, id);
    this.visitors.set(id, {
      value: {
        id,
        lastSeen: Math.max(existing?.lastSeen ?? -Infinity, state.lastSeen),
        ...(lastInteractionAt === -Infinity ? {} : { lastInteractionAt }),
      },
      expiresAt: this.now() + ttlSeconds * 1000,
    });
  }

  async incrementCounter(key: string, windowSeconds: number): Promise<number> {
    validateWindow(windowSeconds);
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
    // Sweep at most once per second, not once per insertion under a flood.
    if (now - (this.sweepTimes.get(map) ?? -Infinity) >= 1000) {
      this.sweepTimes.set(map, now);
      for (const [key, entry] of map) {
        if (entry.expiresAt <= now) map.delete(key);
      }
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

// The fallback keeps state in this process only, so a deployment that runs more
// than one instance silently loses rate limiting and interaction continuity.
// Warn once per runtime rather than per request.
function getDefaultStorage(): MemoryBotStorage {
  if (!warnedAboutDefaultStorage) {
    warnedAboutDefaultStorage = true;
    console.warn(
      "NoSkrap: no `storage` configured, falling back to in-memory storage. " +
        "State is process-local, so rate limiting and interaction continuity " +
        "degrade across Next.js proxy/route bundles and serverless, edge, or multi-instance deployments. " +
        "Pass a shared `storage` implementation in production.",
    );
  }
  defaultMemoryStorage ??= new MemoryBotStorage();
  return defaultMemoryStorage;
}

export async function signVisitorToken(
  payload: { id: string },
  secret: string,
): Promise<string> {
  validateSecrets(secret);
  if (typeof payload.id !== "string" || !payload.id) throw new TypeError("visitor id is required");
  const body = encodeJson(payload);
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
  const body = encodeJson(payload);
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

function matchingProtectedRoute(
  pathname: string,
  protectedRoutes: string[] = [],
): string | null {
  const normalizedPath = pathname.replace(/\/+$/, "") || "/";
  let match: string | null = null;
  for (const path of protectedRoutes) {
    const route = path.replace(/\/+$/, "") || "/";
    if (
      (route === "/" || normalizedPath === route || normalizedPath.startsWith(`${route}/`)) &&
      (match === null || route.length > match.length)
    ) match = route;
  }
  return match;
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

export function validateConfig(config: NoSkrapConfig): void {
  validateSecrets(config.secret);
  if (config.protectedRoutes?.some(route => typeof route !== "string" || !route.startsWith("/") || route.startsWith("//") || /[?#\\]/.test(route))) {
    throw new TypeError("protectedRoutes must contain absolute URL paths");
  }
  validateDeadline(config.storageTimeoutMs, "storageTimeoutMs");
  if (config.storageFailureMode !== undefined && !["open", "closed"].includes(config.storageFailureMode)) {
    throw new TypeError('storageFailureMode must be "open" or "closed"');
  }
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

export function validateWindow(seconds: number): void {
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new TypeError("window/ttl must be a positive safe integer");
}

export function validateVisitorState(id: string, state: VisitorState, ttlSeconds: number): void {
  validateWindow(ttlSeconds);
  if (!id || state.id !== id || !Number.isFinite(state.lastSeen) ||
    (state.lastInteractionAt !== undefined && !Number.isFinite(state.lastInteractionAt))) {
    throw new TypeError("visitor state must have a matching id and finite timestamps");
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

function encodeJson(payload: object): string {
  // ASCII escapes preserve the existing token decoder and legacy Latin-1 tokens.
  return base64UrlEncode(JSON.stringify(payload).replace(/[\u007f-\uffff]/g,
    character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`));
}
