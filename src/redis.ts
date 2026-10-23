import { type BotStorage, type VisitorState, validateVisitorState, validateWindow } from "./core.js";

// ioredis shape. Other transports use the explicit adapters below.
export interface RedisLikeClient {
  withSignal?: (signal: AbortSignal) => RedisLikeClient;
  get(key: string): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface NodeRedisClient {
  withCommandOptions?: (options: { abortSignal: AbortSignal }) => NodeRedisClient;
  get(key: string): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface UpstashRedisClient {
  get(key: string): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export function adaptNodeRedis(client: NodeRedisClient): RedisLikeClient {
  return {
    ...(client.withCommandOptions ? { withSignal: (signal: AbortSignal) => adaptNodeRedis(client.withCommandOptions!({ abortSignal: signal })) } : {}),
    get: key => client.get(key),
    eval: (script, count, ...args) => client.eval(script, { keys: args.slice(0, count), arguments: args.slice(count) }),
  };
}

export function adaptUpstashRedis(
  client: UpstashRedisClient,
  withSignal?: (signal: AbortSignal) => UpstashRedisClient,
): RedisLikeClient {
  return {
    ...(withSignal ? { withSignal: (signal: AbortSignal) => adaptUpstashRedis(withSignal(signal)) } : {}),
    get: key => client.get(key),
    eval: (script, count, ...args) => client.eval(script, args.slice(0, count), args.slice(count)),
  };
}

export interface RedisBotStorageOptions {
  keyPrefix?: string;
  now?: () => number;
}

const MERGE_VISITOR = `
local next = cjson.decode(ARGV[1])
local raw = redis.call('GET', KEYS[1])
if raw then
  local ok, old = pcall(cjson.decode, raw)
  if ok and type(old) == 'table' and old.id == next.id then
    if type(old.lastSeen) == 'number' then next.lastSeen = math.max(next.lastSeen, old.lastSeen) end
    if type(old.lastInteractionAt) == 'number' then
      next.lastInteractionAt = math.max(next.lastInteractionAt or old.lastInteractionAt, old.lastInteractionAt)
    end
  end
end
return redis.call('SET', KEYS[1], cjson.encode(next), 'EX', ARGV[2])
`;

const INCREMENT_COUNTER = `
local old = redis.call('HMGET', KEYS[1], 'bucket', 'current', 'previous')
local bucket = tonumber(ARGV[1])
local weight = tonumber(ARGV[2])
local current, previous = 1, 0
if old[1] then
  local prior = tonumber(old[1])
  if prior > bucket then bucket, weight = prior, 1 end
  if prior == bucket then
    current, previous = tonumber(old[2]) + 1, tonumber(old[3])
  elseif prior == bucket - 1 then previous = tonumber(old[2]) end
end
redis.call('HSET', KEYS[1], 'bucket', bucket, 'current', current, 'previous', previous)
redis.call('EXPIRE', KEYS[1], ARGV[3])
return tostring(current + previous * weight)
`;

export class RedisBotStorage implements BotStorage {
  private readonly keyPrefix: string;
  private readonly now: () => number;

  constructor(private readonly client: RedisLikeClient, options: RedisBotStorageOptions = {}) {
    for (const method of ["get", "eval"] as const) {
      if (typeof client?.[method] !== "function") throw new TypeError(`redis client must implement ${method}()`);
    }
    this.keyPrefix = options.keyPrefix ?? "noskrap:";
    this.now = options.now ?? Date.now;
  }

  async getVisitor(id: string, signal?: AbortSignal): Promise<VisitorState | null> {
    const raw = await this.operationClient(signal).get(this.visitorKey(id));
    let value: unknown = raw;
    if (typeof raw === "string") {
      try { value = JSON.parse(raw); } catch { return null; }
    }
    if (typeof value !== "object" || value === null) return null;
    const record = value as Record<string, unknown>;
    const interaction = record.lastInteractionAt;
    if (record.id !== id || typeof record.lastSeen !== "number" || !Number.isFinite(record.lastSeen) ||
      (interaction !== undefined && (typeof interaction !== "number" || !Number.isFinite(interaction)))) return null;
    return { id, lastSeen: record.lastSeen, ...(typeof interaction === "number" ? { lastInteractionAt: interaction } : {}) };
  }

  async setVisitor(id: string, state: VisitorState, ttlSeconds: number, signal?: AbortSignal): Promise<void> {
    validateVisitorState(id, state, ttlSeconds);
    const reply = await this.operationClient(signal).eval(MERGE_VISITOR, 1, this.visitorKey(id), JSON.stringify(state), String(ttlSeconds));
    if (reply !== "OK") throw new TypeError("redis visitor write returned an invalid acknowledgement");
  }

  async incrementCounter(key: string, windowSeconds: number, signal?: AbortSignal): Promise<number> {
    validateWindow(windowSeconds);
    const duration = windowSeconds * 1000;
    const now = this.now();
    const bucket = Math.floor(now / duration);
    const reply = await this.operationClient(signal).eval(INCREMENT_COUNTER, 1,
      `${this.keyPrefix}counter:${windowSeconds}:${key}`, String(bucket), String(1 - (now % duration) / duration), String(windowSeconds * 2));
    const count = typeof reply === "string" && /^\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(reply) ? Number(reply) : reply;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 1 || count > Number.MAX_SAFE_INTEGER) throw new TypeError("redis counter returned an invalid count");
    return count;
  }

  private operationClient(signal?: AbortSignal): RedisLikeClient {
    signal?.throwIfAborted();
    return signal && this.client.withSignal ? this.client.withSignal(signal) : this.client;
  }

  private visitorKey(id: string): string {
    return `${this.keyPrefix}visitor:${id}`;
  }
}
