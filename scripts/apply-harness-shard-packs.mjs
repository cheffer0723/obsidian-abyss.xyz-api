import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packsDir = path.join(root, "data/testing-harness/shard-packs");
const partsDir = path.join(root, "data/testing-harness/market-history.parts");
fs.mkdirSync(partsDir, { recursive: true });
let n=0;
for (const name of fs.readdirSync(packsDir).filter(n=>n.endsWith(".mjs")).sort()) {
  const mod = await import(pathToFileURL(path.join(packsDir, name)).href);
  for (const [file, content] of Object.entries(mod.shards)) {
    fs.writeFileSync(path.join(partsDir, file), content);
    n+=1;
  }
}
console.log(JSON.stringify({ wrote: n }));
