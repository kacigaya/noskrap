import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { RedisBotStorage, adaptNodeRedis, adaptUpstashRedis, type RedisLikeClient } from "./redis.js";

describe("redis client contracts", () => {
  test("adapts node-redis and preserves method receivers", async () => {
    const calls: unknown[] = [];
    const client = {
      calls,
      get: async function (key: string) { this.calls.push(key); return null; },
      eval: async function (script: string, options: { keys: string[]; arguments: string[] }) {
        this.calls.push([script, options]); return 1;
      },
    };
    const adapted = adaptNodeRedis(client);
    await adapted.get("visitor");
    assert.equal(await adapted.eval("script", 1, "key", "arg"), 1);
    assert.deepEqual(calls, ["visitor", ["script", { keys: ["key"], arguments: ["arg"] }]]);
  });

  test("adapts Upstash's keys/args shape", async () => {
    const calls: unknown[] = [];
    const adapted = adaptUpstashRedis({
      get: async () => null,
      eval: async (script, keys, args) => { calls.push([script, keys, args]); return 1; },
    });
    assert.equal(await adapted.eval("script", 1, "key", "arg"), 1);
    assert.deepEqual(calls, [["script", ["key"], ["arg"]]]);
  });

  test("validates deserialized visitor records", async () => {
    let value: unknown = { id: "v_a", lastSeen: 10, lastInteractionAt: 5 };
    const client: RedisLikeClient = { get: async () => value, eval: async () => 1 };
    const storage = new RedisBotStorage(client);
    assert.deepEqual(await storage.getVisitor("v_a"), { id: "v_a", lastSeen: 10, lastInteractionAt: 5 });
    for (const invalid of [null, "not json", { id: "v_other", lastSeen: 10 }, { id: "v_a", lastSeen: Infinity }, { id: "v_a", lastSeen: 10, lastInteractionAt: NaN }]) {
      value = invalid;
      assert.equal(await storage.getVisitor("v_a"), null);
    }
  });

  test("rejects invalid counter replies and missing atomic commands", async () => {
    const storage = new RedisBotStorage({ get: async () => null, eval: async () => "1" });
    await assert.rejects(storage.incrementCounter("route", 60), new RegExp("invalid count"));
    assert.throws(() => new RedisBotStorage({ get: async () => null } as unknown as RedisLikeClient), new RegExp("implement eval\\(\\)"));
    await assert.rejects(storage.incrementCounter("route", 0), new RegExp("positive safe integer"));
  });
});
