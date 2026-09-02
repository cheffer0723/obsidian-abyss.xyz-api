import { build } from "esbuild";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(path.join(tmpdir(), "obsidian-harness-test-"));
const outfile = path.join(directory, "test.mjs");
try {
  await build({
    entryPoints: [new URL("./testing-harness.test.ts", import.meta.url).pathname.replace(/^\/(\w:)/, "$1")],
    platform: "node",
    bundle: true,
    format: "esm",
    outfile,
    sourcemap: "inline",
    logLevel: "silent",
    external: ["*.node"],
    banner: { js: "import { createRequire as __testCreateRequire } from 'node:module'; const require = __testCreateRequire(import.meta.url);" },
  });
  await import(pathToFileURL(outfile).href);
} finally {
  await rm(directory, { recursive: true, force: true });
}
