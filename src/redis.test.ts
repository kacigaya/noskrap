import { describe, expect, test } from "bun:test";
import { RedisBotStorage, type RedisLikeClient } from "./redis";

// Enough of Redis to exercise the adapter: string values, INCR, and TTLs
// driven by a controllable clock.
class FakeRedis implements RedisLikeClient {
  now = 0;
  values = new Map<string, string>();
  ttls = new Map<string, number>();
  calls: string[] = [];

  // Typed as `unknown` like the adapter interface so a test can swap in a
  // client that deserializes on read.
  async get(key: string): Promise<unknown> {
    this.calls.push(`get ${key}`);
    this.evict(key);
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<"OK"> {
    this.calls.push(`set ${key}`);
    this.values.set(key, value);
    this.ttls.delete(key);
    return "OK";
  }

  async incr(key: string): Promise<number> {
    this.calls.push(`incr ${key}`);
    this.evict(key);
    const next = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, String(next));
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    this.calls.push(`expire ${key} ${seconds}`);
    if (!this.values.has(key)) return 0;
    this.ttls.set(key, this.now + seconds * 1000);
    return 1;
  }

  private evict(key: string): void {
    const expiresAt = this.ttls.get(key);
    if (expiresAt !== undefined && expiresAt <= this.now) {
      this.values.delete(key);
      this.ttls.delete(key);
    }
  }
}

describe("redis storage", () => {
  test("round-trips visitor state with a ttl", async () => {
    const redis = new FakeRedis();
    const storage = new RedisBotStorage(redis);
    const state = { id: "v_a", lastSeen: 10, lastInteractionAt: 5 };

    await storage.setVisitor("v_a", state, 60);

    expect(await storage.getVisitor("v_a")).toEqual(state);
    expect(redis.calls).toEqual([
      "set noskrap:visitor:v_a",
      "expire noskrap:visitor:v_a 60",
      "get noskrap:visitor:v_a",
    ]);

    redis.now = 60_001;
    expect(await storage.getVisitor("v_a")).toBeNull();
  });

  test("returns null for missing and malformed visitors", async () => {
    const redis = new FakeRedis();
    const storage = new RedisBotStorage(redis);

    expect(await storage.getVisitor("v_missing")).toBeNull();

    await redis.set("noskrap:visitor:v_bad", "not json");
    expect(await storage.getVisitor("v_bad")).toBeNull();

    await redis.set("noskrap:visitor:v_shape", JSON.stringify({ id: 1 }));
    expect(await storage.getVisitor("v_shape")).toBeNull();
  });

  test("accepts values a client already deserialized", async () => {
    const state = { id: "v_a", lastSeen: 10 };
    const redis = new FakeRedis();
    redis.get = async () => state;
    const storage = new RedisBotStorage(redis);

    expect(await storage.getVisitor("v_a")).toEqual(state);
  });

  test("counts inside clock-aligned windows", async () => {
    const redis = new FakeRedis();
    const storage = new RedisBotStorage(redis, { now: () => redis.now });

    redis.now = 1_000;
    expect(await storage.incrementCounter("route", 60)).toBe(1);
    expect(await storage.incrementCounter("route", 60)).toBe(2);
    expect(redis.calls).toEqual([
      "incr noskrap:counter:route:0",
      "expire noskrap:counter:route:0 60",
      "incr noskrap:counter:route:0",
    ]);

    redis.now = 60_000;
    expect(await storage.incrementCounter("route", 60)).toBe(1);
  });

  test("recovers from a lost counter ttl once the window passes", async () => {
    const redis = new FakeRedis();
    const storage = new RedisBotStorage(redis, { now: () => redis.now });
    const expire = redis.expire.bind(redis);
    redis.expire = async () => 0;

    await storage.incrementCounter("route", 60);
    redis.expire = expire;
    expect(redis.ttls.size).toBe(0);

    redis.now = 60_000;
    expect(await storage.incrementCounter("route", 60)).toBe(1);
  });

  test("namespaces keys with the configured prefix", async () => {
    const redis = new FakeRedis();
    const storage = new RedisBotStorage(redis, {
      keyPrefix: "app:bots:",
      now: () => 0,
    });

    await storage.setVisitor("v_a", { id: "v_a", lastSeen: 0 }, 60);
    await storage.incrementCounter("route", 60);

    expect([...redis.values.keys()]).toEqual([
      "app:bots:visitor:v_a",
      "app:bots:counter:route:0",
    ]);
  });

  test("rejects clients missing a required command", async () => {
    expect(
      () => new RedisBotStorage({} as unknown as RedisLikeClient),
    ).toThrow("redis client must implement get()");
  });
});
