import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("release upload passes a local tarball to npm", async () => {
  const directory = await mkdtemp(join(tmpdir(), "noskrap-upload-test-"));
  try {
    await mkdir(join(directory, "fixture/package"), { recursive: true });
    await mkdir(join(directory, "package"));
    await writeFile(join(directory, "fixture/package/package.json"), JSON.stringify({ name: "noskrap-release-fixture", version: "1.0.0" }));
    const archive = Bun.spawn(["tar", "-czf", join(directory, "package/noskrap-1.0.0.tgz"), "package"],
      { cwd: join(directory, "fixture"), stderr: "inherit" });
    expect(await archive.exited).toBe(0);
    const workflow = await Bun.file(join(import.meta.dir, "../.github/workflows/publish.yml")).text();
    const start = workflow.indexOf("          shopt -s nullglob\n");
    const end = workflow.indexOf("          export NOSKRAP_RELEASE_ARCHIVE=", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const upload = workflow.slice(start, end).replace(/^          /gm, "");
    // Exercise the real upload shell and npm parser without publishing or
    // contacting the registry. Reject GitHub shorthand before npm can use git.
    const script = `npm() {
      case "$2" in ./*|/*) ;; *) echo "Expected a local tarball path" >&2; return 1 ;; esac
      command npm "$@" --dry-run --ignore-scripts --offline --json
    }
    ${upload}`;
    const process = Bun.spawn(["bash", "-e", "-o", "pipefail", "-c", script], {
      cwd: directory, env: { ...globalThis.process.env, npm_config_cache: join(directory, "cache"), npm_config_userconfig: "/dev/null" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, output, errors] = await Promise.all([
      process.exited, new Response(process.stdout).text(), new Response(process.stderr).text(),
    ]);
    expect(exit, errors).toBe(0);
    expect(output).toContain('"id": "noskrap-release-fixture@1.0.0"');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

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
