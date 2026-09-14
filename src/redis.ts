import type { BotStorage, VisitorState } from "./core.js";

// The subset of a Redis client that the adapter needs. It is deliberately the
// lowest common denominator of ioredis, node-redis, and @upstash/redis, so any
// of them can be passed in directly. TTLs go through `expire` rather than the
// options argument of `set`, because that argument is spelled differently in
// each client.
export interface RedisLikeClient {
  get(key: string): Promise<unknown>;
  set(key: string, value: string): Promise<unknown>;
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
}

export interface RedisBotStorageOptions {
  // Namespaces every key so the store can share a database. Defaults to
  // `noskrap:`.
  keyPrefix?: string;
  // Clock used to align counter windows. Tests override it.
  now?: () => number;
}

// Shared `BotStorage` for deployments that run more than one instance. Redis
// owns capacity and expiry, so nothing here is bounded or swept by hand.
export class RedisBotStorage implements BotStorage {
  private readonly keyPrefix: string;
  private readonly now: () => number;

  constructor(
    private readonly client: RedisLikeClient,
    options: RedisBotStorageOptions = {},
  ) {
    for (const method of ["get", "set", "incr", "expire"] as const) {
      if (typeof client?.[method] !== "function") {
        throw new TypeError(`redis client must implement ${method}()`);
      }
    }
    this.keyPrefix = options.keyPrefix ?? "noskrap:";
    this.now = options.now ?? Date.now;
  }

  async getVisitor(id: string): Promise<VisitorState | null> {
    const raw = await this.client.get(this.visitorKey(id));
    if (raw === null || raw === undefined) return null;

    // @upstash/redis deserializes JSON values on read; the other clients
    // return the stored string.
    let value: unknown = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return isVisitorState(value) ? value : null;
  }

  async setVisitor(
    id: string,
    state: VisitorState,
    ttlSeconds: number,
  ): Promise<void> {
    const key = this.visitorKey(id);
    await this.client.set(key, JSON.stringify(state));
    await this.client.expire(key, ttlSeconds);
  }

  // Windows are aligned to the clock and baked into the key. The TTL is only
  // set on the first hit, so if the process dies between `incr` and `expire`
  // the key survives without one; the bucket suffix guarantees it is never
  // read again once its window has passed, so a lost TTL costs a stale key,
  // not a permanently inflated counter.
  async incrementCounter(key: string, windowSeconds: number): Promise<number> {
    const bucket = Math.floor(this.now() / (windowSeconds * 1000));
    const counterKey = `${this.keyPrefix}counter:${key}:${bucket}`;
    const count = await this.client.incr(counterKey);
    if (count === 1) {
      await this.client.expire(counterKey, windowSeconds);
    }
    return count;
  }

  private visitorKey(id: string): string {
    return `${this.keyPrefix}visitor:${id}`;
  }
}

function isVisitorState(value: unknown): value is VisitorState {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.lastSeen === "number" &&
    (record.lastInteractionAt === undefined ||
      typeof record.lastInteractionAt === "number")
  );
}
