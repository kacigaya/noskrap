import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const directory = await mkdtemp(join(tmpdir(), "noskrap-package-"));
try {
  const manifest: unknown = await Bun.file(join(root, "package.json")).json();
  assert(typeof manifest === "object" && manifest !== null);
  assert("name" in manifest && manifest.name === "noskrap");
  assert("version" in manifest && typeof manifest.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(manifest.version));
  const filename = `noskrap-${manifest.version}.tgz`;
  const archive = join(directory, filename);
  const pack = Bun.spawn(["bun", "pm", "pack", "--destination", directory], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, output, errors] = await Promise.all([
    pack.exited, new Response(pack.stdout).text(), new Response(pack.stderr).text(),
  ]);
  assert.equal(exitCode, 0, `${output}\n${errors}`);
  const list = Bun.spawn(["tar", "-tzf", archive], { stdout: "pipe", stderr: "inherit" });
  const files = (await new Response(list.stdout).text()).trim().split("\n");
  assert.equal(await list.exited, 0);
  for (const file of files) {
    assert(/^package\/(dist\/[a-z-]+\.(js|d\.ts)|package\.json|README\.md|LICENSE)$/.test(file), `Unexpected package file: ${file}`);
    assert(!file.includes(".test."), "Test files must not be published");
  }
  const extract = Bun.spawn(["tar", "-xzf", archive, "-C", directory], { stdout: "inherit", stderr: "inherit" });
  assert.equal(await extract.exited, 0);
  await mkdir(join(directory, "node_modules"));
  await symlink(join(directory, "package"), join(directory, "node_modules/noskrap"), "dir");
  await writeFile(join(directory, "smoke.mjs"), `
import assert from "node:assert/strict";
import { scoreRequest, MemoryBotStorage } from "noskrap/core";
import { getNoSkrapDecision } from "noskrap/next";
import { RedisBotStorage, adaptNodeRedis, adaptUpstashRedis } from "noskrap/redis";
import { showBotDetectedPopup } from "noskrap/client";
const config = { secret: "package-test-secret-at-least-32-bytes", storage: new MemoryBotStorage() };
const request = new Request("https://example.test/api");
assert.equal((await scoreRequest(request, config)).scoringAvailable, true);
assert.equal((await getNoSkrapDecision(request, config)).scoringAvailable, true);
for (const fn of [RedisBotStorage, adaptNodeRedis, adaptUpstashRedis, showBotDetectedPopup]) assert.equal(typeof fn, "function");
for (const entry of ["core", "next", "redis", "client"]) assert(import.meta.resolve("noskrap/" + entry).includes("/package/dist/"));
`);
  const smoke = Bun.spawn(["node", join(directory, "smoke.mjs")], { cwd: directory, stdout: "inherit", stderr: "inherit" });
  assert.equal(await smoke.exited, 0, "Published entrypoints must work under Node without development dependencies");
  const outputDirectory = process.env.NOSKRAP_PACKAGE_OUTPUT;
  if (outputDirectory) {
    await mkdir(outputDirectory, { recursive: true });
    await copyFile(archive, join(outputDirectory, filename), constants.COPYFILE_EXCL);
  }
  console.log(`Package ${manifest.version}: tarball contents and all four Node entrypoints passed.`);
} finally { await rm(directory, { recursive: true, force: true }); }
