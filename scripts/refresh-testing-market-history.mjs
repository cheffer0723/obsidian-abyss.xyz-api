/**
 * Refresh bundled harness market history from Yahoo chart daily adj-close.
 * Research/historical testing only — not a live signal feed.
 *
 * Usage: node scripts/refresh-testing-market-history.mjs
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const symbols = ["SPY", "QQQ", "NVDA", "GLD", "IWM", "TLT", "BTC-USD", "ETH-USD", "SOL-USD"];
const period1 = Math.floor(Date.UTC(2014, 0, 1) / 1000);
const period2 = Math.floor(Date.now() / 1000);
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-market-"));

async function fetchBars(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${period1}&period2=${period2}&interval=1d&includeAdjustedClose=true`;
  const response = await fetch(url, { headers: { "user-agent": "ObsidianAbyssResearch/1.0" } });
  if (!response.ok) throw new Error(`${symbol} fetch failed: ${response.status}`);
  const payload = await response.json();
  const result = payload?.chart?.result?.[0];
  const timestamps = result?.timestamp;
  const closes = result?.indicators?.adjclose?.[0]?.adjclose;
  if (!Array.isArray(timestamps) || !Array.isArray(closes)) throw new Error(`${symbol} missing chart series`);
  const byDate = new Map();
  for (let i = 0; i < timestamps.length; i += 1) {
    const close = closes[i];
    if (typeof close !== "number" || !Number.isFinite(close) || close <= 0) continue;
    const date = new Date(timestamps[i] * 1000).toISOString().slice(0, 10);
    byDate.set(date, close);
  }
  return [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b));
}

for (const symbol of symbols) {
  const bars = await fetchBars(symbol);
  if (bars.length < 100) throw new Error(`${symbol} returned too few bars (${bars.length})`);
  const file = path.join(outDir, `${symbol}.csv`);
  fs.writeFileSync(file, ["Date,Adj Close", ...bars.map(([date, close]) => `${date},${close}`)].join("\n") + "\n");
  console.log(JSON.stringify({ symbol, firstDate: bars[0][0], lastDate: bars.at(-1)[0], bars: bars.length }));
}

const build = spawnSync(process.execPath, [path.join(root, "scripts/build-testing-market-history.mjs")], {
  cwd: root,
  env: { ...process.env, ENGINE_MARKET_DATA_DIR: outDir },
  encoding: "utf8",
});
if (build.status !== 0) {
  console.error(build.stdout || "");
  console.error(build.stderr || "");
  process.exit(build.status || 1);
}
console.log(build.stdout.trim());
fs.rmSync(outDir, { recursive: true, force: true });
