import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const inputDirectory = String(process.env.ENGINE_MARKET_DATA_DIR || "").trim();
if (!inputDirectory) throw new Error("ENGINE_MARKET_DATA_DIR is required.");

const assets = [
  ["SPY", "eq"], ["QQQ", "eq"], ["NVDA", "eq"], ["GLD", "eq"], ["IWM", "eq"], ["TLT", "eq"],
  ["BTC-USD", "btc"], ["ETH-USD", "btc"], ["SOL-USD", "btc"],
];
const output = {
  generatedAt: new Date().toISOString(),
  purpose: "historical_testing_only",
  source: "Recovered daily adjusted-close research files; frozen local snapshot",
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
const target = path.resolve("data/testing-harness/market-history.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(output)}\n`);
console.log(JSON.stringify({ target, assets: Object.keys(output.assets).length, bytes: fs.statSync(target).size }));
