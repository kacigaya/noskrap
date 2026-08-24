import { expect, test } from "bun:test";
import { MemoryBotStorage } from "./core";

const SECRET = "test-secret-with-at-least-32-bytes";

// The warning fires once per module instance. Importing with a unique query
// gives each test its own copy of the module state, so these stay independent
// of each other and of whatever the rest of the suite already triggered.
let moduleCounter = 0;
async function freshCore(): Promise<typeof import("./core")> {
  moduleCounter += 1;
  return import(`./core.ts?storage-warning=${moduleCounter}`);
}

function captureWarnings(): { messages: string[]; restore: () => void } {
  const original = console.warn;
  const messages: string[] = [];
  console.warn = (...args: unknown[]) => {
    messages.push(args.join(" "));
  };
  return { messages, restore: () => (console.warn = original) };
}

test("warns when no storage is configured", async () => {
  const core = await freshCore();
  const warnings = captureWarnings();

  try {
    await core.scoreRequest(new Request("https://example.test/"), {
      secret: SECRET,
    });
  } finally {
    warnings.restore();
  }

  expect(warnings.messages).toHaveLength(1);
  expect(warnings.messages[0]).toContain("no `storage` configured");
});

test("warns only once across repeated calls", async () => {
  const core = await freshCore();
  const warnings = captureWarnings();

  try {
    for (let i = 0; i < 3; i += 1) {
      await core.scoreRequest(new Request("https://example.test/"), {
        secret: SECRET,
      });
    }
  } finally {
    warnings.restore();
  }

  expect(warnings.messages).toHaveLength(1);
});

test("does not warn when storage is supplied", async () => {
  const core = await freshCore();
  const warnings = captureWarnings();

  try {
    await core.scoreRequest(new Request("https://example.test/"), {
      secret: SECRET,
      storage: new MemoryBotStorage(),
    });
  } finally {
    warnings.restore();
  }

  expect(warnings.messages).toEqual([]);
});
