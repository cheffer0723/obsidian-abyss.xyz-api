/**
 * Install MCP-friendly harness market shards (*.gz.part.b64.SS).
 * Usage: node scripts/install-harness-shards.mjs
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const partsDir = path.join(root, "data/testing-harness/market-history.parts");
const url = process.env.HARNESS_SHARDS_URL || "https://litter.catbox.moe/rzsf0x.gz";
const expected = process.env.HARNESS_SHARDS_SHA256 || "858a01a2448103ad5c56ad0ac7cd237929b1cb22c9f0bef571abc384642a945e";

fs.mkdirSync(partsDir, { recursive: true });
const archive = path.join(partsDir, ".harness-shards.tar.gz");
const response = await fetch(url);
if (!response.ok) throw new Error(`download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(bytes).digest("hex");
if (digest !== expected) throw new Error(`sha256 mismatch: ${digest}`);
fs.writeFileSync(archive, bytes);
const extract = spawnSync("tar", ["xzf", archive, "-C", partsDir], { encoding: "utf8" });
if (extract.status !== 0) throw new Error(extract.stderr || "tar extract failed");
fs.unlinkSync(archive);
const shards = fs.readdirSync(partsDir).filter((n) => /\.gz\.part\.b64\.\d+$/.test(n));
if (shards.length !== 195) throw new Error(`expected 195 shards, got ${shards.length}`);
console.log(JSON.stringify({ ok: true, shards: shards.length, url, sha256: digest }));
