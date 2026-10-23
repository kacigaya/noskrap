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
  contextTtlMs?: number;
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
const IP_BURST_LIMIT = 60;
const VISITOR_BURST_LIMIT = 30;
// A heavy burst alone must reach the default challenge band (35 + 30 = 65).
const HEAVY_BURST_FACTOR = 3;
// New visitors per trusted IP per window. Shared NATs see many first visits,
// so the limit stays well above what one household or office produces.
const NEW_VISITOR_LIMIT = 20;
// HTTP libraries and automation tools. Declared crawlers are not listed so
// search engines keep their reputation; score them with your own rules.
const AUTOMATION_UA = new RegExp([
  "HeadlessChrome", "PhantomJS", "Puppeteer", "Playwright", "curl", "wget",
  "python-requests", "python-urllib", "python-httpx", "aiohttp", "Scrapy",
  "Go-http-client", "node-fetch", "undici", "axios/", "okhttp",
  "Apache-HttpClient", "libwww-perl", "PostmanRuntime", "^Java/", "^node$",
  "^Bun/", "^Deno/",
].join("|"), "i");
const INTERACTION_TTL_MS = 10 * 60 * 1000;
const MIN_SECRET_LENGTH = 32;
const TELEMETRY_TOKEN_MAX_AGE_MS = 10 * 60 * 1000;
export const TELEMETRY_TOKEN_HEADER = "x-noskrap-telemetry";
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

  if (AUTOMATION_UA.test(userAgent)) {
    addReason("browser.automationUa", 30);
  }

  // Browsers send these headers only to potentially trustworthy origins, so
  // plain HTTP deployments skip the checks instead of flagging every visitor.
  if (isTrustworthyOrigin(url)) {
    const browser = claimedBrowser(userAgent);
    if (browser && !secFetchMode) {
      addReason("headers.missingFetchMetadata", 25);
    }
    const brands = headers.get("sec-ch-ua");
    if (browser === "chromium" && brands === null && sendsClientHints(request, userAgent)) {
      addReason("headers.missingClientHints", 15);
    } else if (browser === "chromium" && brands !== null && !hasVendorBrand(brands)) {
      addReason("headers.unbrandedChromium", 10);
    }
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

  // rate.heavyBurst escalates rate.routeBurst; disabling the base rule stops
  // counting altogether.
  const rateEnabled = ruleScore(config, "rate.routeBurst", 35) > 0;
  const interactionEnabled = ruleScore(config, "behavior.noRecentInteraction", 30) > 0;
  const churnEnabled = ruleScore(config, "behavior.cookieChurn", 20) > 0;
  const ip = rateEnabled || (churnEnabled && !tokenPayload)
    ? config.getClientIp?.(request)?.trim() : undefined;
  const routeKey = protectedRoute ?? "*";
  let scoringAvailable = true;
  try {
    const [existing, ipCount, visitorCount, newVisitorCount] = await storageOperation(
      signal => Promise.all([
        interactionEnabled && tokenPayload && isProtected && isUnsafeMethod(request.method)
          ? storage.getVisitor(visitorId, signal)
          : Promise.resolve(null),
        rateEnabled && ip ? storage.incrementCounter(`ip:${ip}:${routeKey}`, RATE_WINDOW_SECONDS, signal) : Promise.resolve(0),
        rateEnabled && tokenPayload ? storage.incrementCounter(`visitor:${visitorId}:${routeKey}`, RATE_WINDOW_SECONDS, signal) : Promise.resolve(0),
        // A client that drops its cookie restarts the per-visitor counter, so
        // count fresh visitor IDs per IP across all routes instead.
        churnEnabled && ip && !tokenPayload ? storage.incrementCounter(`new:${ip}`, RATE_WINDOW_SECONDS, signal) : Promise.resolve(0),
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
    if (ipCount > IP_BURST_LIMIT || visitorCount > VISITOR_BURST_LIMIT) {
      addReason("rate.routeBurst", 35);
    }
    if (
      ipCount > IP_BURST_LIMIT * HEAVY_BURST_FACTOR ||
      visitorCount > VISITOR_BURST_LIMIT * HEAVY_BURST_FACTOR
    ) {
      addReason("rate.heavyBurst", 30);
    }
    if (newVisitorCount > NEW_VISITOR_LIMIT) addReason("behavior.cookieChurn", 20);
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

export interface TelemetryTokenOptions {
  // Reject tokens younger than this. Defaults to 0: real visitors can click
  // within a second, and a scraper can wait out any minimum.
  minAgeMs?: number;
  // Defaults to 10 minutes.
  maxAgeMs?: number;
}

interface TelemetryToken {
  id: string;
  kind: "noskrap-telemetry";
  issuedAt: number;
}

// Issue while rendering the page. Returns null without a valid visitor cookie;
// behind the NoSkrap proxy, first visits already carry the new cookie.
export async function createTelemetryToken(
  request: Request,
  config: NoSkrapConfig,
): Promise<string | null> {
  validateConfig(config);
  const visitorToken = getCookie(request, VISITOR_COOKIE);
  const visitor = visitorToken ? await verifyVisitorToken(visitorToken, config.secret) : null;
  if (!visitor) return null;
  const token: TelemetryToken = {
    id: visitor.id,
    kind: "noskrap-telemetry",
    issuedAt: config.now?.() ?? Date.now(),
  };
  return signVisitorToken(token, firstSecret(config.secret));
}

// Checks the `x-noskrap-telemetry` header against the visitor cookie. This
// proves the visitor loaded a page you rendered, not that a human used it.
export async function verifyTelemetryToken(
  request: Request,
  config: NoSkrapConfig,
  options: TelemetryTokenOptions = {},
): Promise<boolean> {
  validateConfig(config);
  const minAgeMs = options.minAgeMs ?? 0;
  const maxAgeMs = options.maxAgeMs ?? TELEMETRY_TOKEN_MAX_AGE_MS;
  if (!(minAgeMs >= 0 && maxAgeMs > minAgeMs && Number.isFinite(maxAgeMs))) {
    throw new TypeError("telemetry token ages must satisfy 0 <= minAgeMs < maxAgeMs");
  }
  const token = request.headers.get(TELEMETRY_TOKEN_HEADER);
  const visitorToken = getCookie(request, VISITOR_COOKIE);
  if (!token || token.length > 1024 || !visitorToken) return false;
  const [payload, visitor] = await Promise.all([
    verifyVisitorToken(token, config.secret) as Promise<Partial<TelemetryToken> | null>,
    verifyVisitorToken(visitorToken, config.secret),
  ]);
  if (!payload || !visitor || payload.kind !== "noskrap-telemetry" ||
    payload.id !== visitor.id || typeof payload.issuedAt !== "number") return false;
  const age = (config.now?.() ?? Date.now()) - payload.issuedAt;
  return age >= minAgeMs && age < maxAgeMs;
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

function isTrustworthyOrigin(url: URL): boolean {
  const host = url.hostname;
  return url.protocol === "https:" || host === "localhost" ||
    host.endsWith(".localhost") || host === "[::1]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// CORS preflights never carry Client Hints, and Android WebView added them in
// version 116. Both still send Sec-Fetch-*, so only this check is skipped.
function sendsClientHints(request: Request, userAgent: string): boolean {
  if (request.method === "OPTIONS" && request.headers.has("access-control-request-method")) {
    return false;
  }
  const webView = /; wv\).*Chrome\/(\d+)/.exec(userAgent);
  return !webView || Number(webView[1]) >= 116;
}

// Versions that send Sec-Fetch-* (Chromium 80, Firefox 90, Safari 16.4) and,
// for Chromium, Sec-CH-UA (89). Older or unknown agents return null so the
// header checks never penalize a browser that cannot send them.
function claimedBrowser(userAgent: string): "chromium" | "firefox" | "safari" | null {
  const chromium = /(?:Chrome|Chromium)\/(\d+)/.exec(userAgent);
  if (chromium) return Number(chromium[1]) >= 89 ? "chromium" : null;
  const firefox = /Firefox\/(\d+)/.exec(userAgent);
  if (firefox) return Number(firefox[1]) >= 90 ? "firefox" : null;
  const safari = /Version\/(\d+)(?:\.(\d+))?.*Safari\//.exec(userAgent);
  if (safari && !/CriOS|FxiOS|EdgiOS/.test(userAgent)) {
    const major = Number(safari[1]);
    const minor = Number(safari[2] ?? 0);
    return major > 16 || (major === 16 && minor >= 4) ? "safari" : null;
  }
  return null;
}

// Branded Chromium builds (Chrome, Edge, Opera, Brave, Samsung Internet)
// name themselves in Sec-CH-UA. Bare Chromium and automation builds list only
// "Chromium" and a GREASE brand such as "Not_A Brand".
function hasVendorBrand(header: string): boolean {
  return [...header.matchAll(/"([^"]*)"\s*;\s*v=/g)].some(([, brand]) =>
    brand !== "Chromium" && !/^Not.?A.?Brand$/i.test(brand));
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
  validateDeadline(config.contextTtlMs, "contextTtlMs");
  if ((config.contextTtlMs ?? 0) > 300_000) throw new TypeError("contextTtlMs must not exceed 300000");
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
