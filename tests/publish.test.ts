import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const scenario of ["visible", "wrong-integrity", "staged"] as const) {
  test(`release verification handles ${scenario} artifacts`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "noskrap-publish-test-"));
    try {
      const archive = join(directory, "noskrap-0.4.0.tgz");
      const bytes = new TextEncoder().encode("verified test artifact");
      await writeFile(archive, bytes);
      const integrity = "sha512-" + createHash("sha512").update(bytes).digest("base64");
      const workflow = await Bun.file(join(import.meta.dir, "../.github/workflows/publish.yml")).text();
      const start = workflow.indexOf("node --input-type=module <<'JS'\n");
      expect(start).toBeGreaterThan(-1);
      const body = workflow.slice(start).split("\n").slice(1);
      const end = body.findIndex(line => line.trim() === "JS");
      expect(end).toBeGreaterThan(-1);
      const verification = body.slice(0, end).map(line => line.replace(/^          /, "")).join("\n");
      const script = join(directory, "verify.mjs");
      await writeFile(script, verification);
      const mock = join(directory, "registry.mjs");
      await writeFile(mock, `
import assert from "node:assert/strict";
let attempts = 0;
globalThis.fetch = async url => {
  assert.equal(url, "https://registry.npmjs.org/noskrap/0.4.0");
  attempts++;
  if (${JSON.stringify(scenario)} === "staged" || attempts === 1) return new Response("missing", { status: 404 });
  return Response.json({ name: "noskrap", version: "0.4.0", dist: {
    integrity: ${JSON.stringify(scenario === "wrong-integrity" ? "sha512-wrong" : integrity)},
  } });
};
const timer = globalThis.setTimeout;
globalThis.setTimeout = (callback, _delay, ...args) => timer(callback, 1, ...args);
if (${JSON.stringify(scenario)} === "staged") {
  let reads = 0;
  Date.now = () => ++reads <= 2 ? 0 : 120001;
}
`);
      const process = Bun.spawn(["node", "--import", mock, script], {
        env: { ...globalThis.process.env, NOSKRAP_RELEASE_ARCHIVE: archive }, stdout: "pipe", stderr: "pipe",
      });
      const [exit, output, errors] = await Promise.all([
        process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
      ]);
      expect(exit).toBe(scenario === "visible" ? 0 : 1);
      if (scenario === "visible") expect(output).toContain("Verified public npm package noskrap@0.4.0");
      else expect(errors).toContain(scenario === "staged" ? "Upload is not publicly available" : "Published artifact integrity mismatch");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
