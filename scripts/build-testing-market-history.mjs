import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const inputDirectory = String(process.env.ENGINE_MARKET_DATA_DIR || "").trim();
if (!inputDirectory) throw new Error("ENGINE_MARKET_DATA_DIR is required.");

const assets = [
  ["SPY", "eq"], ["QQQ", "eq"], ["NVDA", "eq"], ["GLD", "eq"], ["IWM", "eq"], ["TLT", "eq"],
  ["BTC-USD", "btc"], ["ETH-USD", "btc"], ["SOL-USD", "btc"],
];
const output = {
  generatedAt: new Date().toISOString(),
  purpose: "historical_testing_only",
  source: "Daily adjusted-close research snapshot for historical harness testing only (not a live signal feed)",
  assets: {},
};
for (const [symbol, kind] of assets) {
  const filename = path.join(inputDirectory, `${symbol}.csv`);
  const bytes = fs.readFileSync(filename);
  const lines = bytes.toString("utf8").trim().split(/\r?\n/);
  const headers = lines[0].split(",");
  const dateIndex = headers.indexOf("Date"), closeIndex = headers.indexOf("Adj Close");
  if (dateIndex < 0 || closeIndex < 0) throw new Error(`${symbol} is missing Date or Adj Close.`);
  const bars = lines.slice(1).map((line, index) => {
    const cells = line.split(","), date = cells[dateIndex], close = Number(cells[closeIndex]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(close) || close <= 0) throw new Error(`${symbol} invalid row ${index + 2}.`);
    return { date, close };
  });
  output.assets[symbol] = {
    kind,
    sourceSha256: crypto.createHash("sha256").update(bytes).digest("hex").toUpperCase(),
    firstDate: bars[0].date,
    lastDate: bars.at(-1).date,
    bars,
  };
}
const json = `${JSON.stringify(output)}\n`;
const target = path.resolve("data/testing-harness/market-history.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, json);

const compressed = zlib.gzipSync(Buffer.from(json), { level: 9 });
const partsDir = path.resolve("data/testing-harness/market-history.parts");
fs.rmSync(partsDir, { recursive: true, force: true });
fs.mkdirSync(partsDir, { recursive: true });
const chunk = 12_000;
const shardChars = 2_000;
let partCount = 0;
for (let offset = 0; offset < compressed.length; offset += chunk) {
  const slice = compressed.subarray(offset, offset + chunk);
  const stem = String(partCount).padStart(3, "0");
  const b64 = slice.toString("base64");
  fs.writeFileSync(path.join(partsDir, `${stem}.gz.part.b64`), b64);
  let shard = 0;
  for (let i = 0; i < b64.length; i += shardChars) {
    fs.writeFileSync(
      path.join(partsDir, `${stem}.gz.part.b64.${String(shard).padStart(2, "0")}`),
      b64.slice(i, i + shardChars),
    );
    shard += 1;
  }
  partCount += 1;
}

console.log(JSON.stringify({
  target,
  partsDir,
  assets: Object.keys(output.assets).length,
  bytes: fs.statSync(target).size,
  partCount,
}));
