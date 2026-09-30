import { type BotStorage, type VisitorState, validateVisitorState, validateWindow } from "./core.js";

// ioredis shape. Other transports use the explicit adapters below.
export interface RedisLikeClient {
  get(key: string): Promise<unknown>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
}

export interface NodeRedisClient {
  get(key: string): Promise<unknown>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
}

export interface UpstashRedisClient {
  get(key: string): Promise<unknown>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
}

export function adaptNodeRedis(client: NodeRedisClient): RedisLikeClient {
  return {
    get: key => client.get(key),
    eval: (script, count, ...args) => client.eval(script, { keys: args.slice(0, count), arguments: args.slice(count) }),
  };
}

export function adaptUpstashRedis(client: UpstashRedisClient): RedisLikeClient {
  return {
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
local count = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return count
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

  async getVisitor(id: string): Promise<VisitorState | null> {
    const raw = await this.client.get(this.visitorKey(id));
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

  async setVisitor(id: string, state: VisitorState, ttlSeconds: number): Promise<void> {
    validateVisitorState(id, state, ttlSeconds);
    const reply = await this.client.eval(MERGE_VISITOR, 1, this.visitorKey(id), JSON.stringify(state), String(ttlSeconds));
    if (reply !== "OK") throw new TypeError("redis visitor write returned an invalid acknowledgement");
  }

  async incrementCounter(key: string, windowSeconds: number): Promise<number> {
    validateWindow(windowSeconds);
    const bucket = Math.floor(this.now() / (windowSeconds * 1000));
    const count = await this.client.eval(INCREMENT_COUNTER, 1, `${this.keyPrefix}counter:${key}:${bucket}`, String(windowSeconds));
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 1) throw new TypeError("redis counter returned an invalid count");
    return count;
  }

  private visitorKey(id: string): string {
    return `${this.keyPrefix}visitor:${id}`;
  }
}
