import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import express from "express";
import { importHistoricalCsv, validateClosedPaperTradesJsonl } from "../src/lib/testing-harness.js";
import { calculateFrozenEngineSignals, evaluateFrozenEngines, FROZEN_ENGINE_SOURCE } from "../src/lib/frozen-engines.js";
import { parseClosedTradesCsv, parseClosedTradesJsonl, replayClosedTrades, type ClosedTradeInput } from "../src/lib/trade-replay.js";
import { historiesFromStore, loadTestingMarketHistory, marketKindsFromStore } from "../src/lib/testing-market-history.js";
import { createRequireActiveSubscription } from "../src/lib/access.js";
import { isAdminEmail } from "../src/lib/account.js";
import testingHarnessRouter from "../src/routes/testing-harness.js";

const header = "txid,ordertxid,pair,aclass,subclass,time,type,ordertype,price,cost,fee,vol,margin,misc,ledgers,posttxid,posstatuscode,cprice,ccost,cfee,cvol,cmargin,net,costusd,trades";
const sample = [
  header,
  "T1,O1,BTC/USD,currency,crypto,2026-03-29 17:11:24.1139,sell,market,66462.1826,24.9998,0.1000,0.00037615,0,,,,,,,,,,,,",
  "T2,O2,BTC/USD,currency,crypto,2026-03-29 18:12:24.0000,buy,market,66317.2,26.4,0.1056,0.00039809,12.5,,,,,,,,,,,,",
  "T3,O2,BTC/USD,currency,crypto,2026-03-29 18:12:25.0000,buy,market,66317.3,1.0,0.004,0.00001508,0.5,,,,,,,,,,,,",
].join("\n");

const parsed = importHistoricalCsv(sample);
assert.equal(parsed.purpose, "historical_testing_only");
assert.equal(parsed.executionCapable, false);
assert.equal(parsed.rows, 3);
assert.equal(parsed.uniqueTransactions, 3);
assert.equal(parsed.uniqueOrders, 2);
assert.equal(parsed.warnings.find((w) => w.code === "partial_fills")?.count, 1);
assert.equal(parsed.warnings.find((w) => w.code === "margin_activity")?.count, 2);
assert.equal(Object.hasOwn(parsed.preview[0], "transactionId"), false);

assert.throws(() => importHistoricalCsv("txid,time\nT1,2026-01-01"), /fields missing/);
assert.throws(() => importHistoricalCsv(sample.replace("0.00037615", "0")), /invalid vol/);

const paper = JSON.stringify({ status: "CLOSED", symbol: "BTC-USD", side: "LONG", entry_timestamp_utc: "2026-01-01T00:00:00Z", exit_timestamp_utc: "2026-01-02T00:00:00Z", entry_price: 100, exit_price: 110, quantity: 2, total_fees_usd: 1, gross_pnl_usd: 20, pnl_usd: 19 });
const paperReport = validateClosedPaperTradesJsonl(`${paper}\nnot-json\n`);
assert.equal(paperReport.verifiedAccounting, 1);
assert.equal(paperReport.invalidRows, 1);
const parsedPaper = parseClosedTradesJsonl(paper);
assert.equal(parsedPaper.length, 1);
assert.equal(parsedPaper[0].symbol, "BTC-USD");
const completedTradeCsv = [
  "symbol,side,entry_timestamp_utc,exit_timestamp_utc,entry_price,exit_price,pnl_usd",
  "BTC/USD,LONG,2026-01-01T00:00:00Z,2026-01-02T00:00:00Z,100,110,9",
].join("\n");
assert.deepEqual(parseClosedTradesCsv(completedTradeCsv), [{ symbol: "BTC-USD", side: "LONG", entryTimestamp: "2026-01-01T00:00:00Z", exitTimestamp: "2026-01-02T00:00:00Z", entryPrice: 100, exitPrice: 110, pnlUsd: 9 }]);
assert.throws(() => parseClosedTradesCsv("symbol,side\nBTC-USD,LONG"), /fields missing/);

// These expected indices independently reproduce pandas rolling/pct_change behavior in the frozen Python source.
const rising = Array.from({ length: 205 }, (_, index) => index + 1);
const risingEquitySignals = calculateFrozenEngineSignals(rising, "eq");
assert.deepEqual(risingEquitySignals.orthrus.flatMap((signal, index) => signal ? [index] : []), [199, 200, 201, 202, 203, 204]);
assert.deepEqual(risingEquitySignals.hydra.flatMap((signal, index) => signal ? [index] : []), Array.from({ length: 79 }, (_, index) => index + 126));
assert.equal(risingEquitySignals.sisyphus.some(Boolean), false);
const risingBitcoinSignals = calculateFrozenEngineSignals(Array.from({ length: 185 }, (_, index) => index + 1), "btc");
assert.deepEqual(risingBitcoinSignals.hydra.flatMap((signal, index) => signal ? [index] : []), [182, 183, 184]);
const oversold = Array(21).fill(100) as number[];
oversold[20] = 50;
assert.deepEqual(calculateFrozenEngineSignals(oversold, "eq").sisyphus.flatMap((signal, index) => signal ? [index] : []), [20]);
assert.equal(calculateFrozenEngineSignals(Array(205).fill(100), "eq").orthrus.some(Boolean), false);

const datedBars = rising.map((close, index) => ({ date: new Date(Date.UTC(2025, 0, index + 1)).toISOString().slice(0, 10), close }));
const frozenEvaluation = evaluateFrozenEngines(datedBars, "eq");
assert.equal(frozenEvaluation.purpose, "historical_testing_only");
assert.equal(frozenEvaluation.executionCapable, false);
assert.equal(frozenEvaluation.source.sha256, FROZEN_ENGINE_SOURCE.sha256);
assert.match(frozenEvaluation.timing.harnessReplayConvention, /strictly earlier/);
assert.throws(() => evaluateFrozenEngines([{ date: "2026-01-01", close: -1 }], "eq"), /positive finite/);
assert.throws(() => evaluateFrozenEngines([{ date: "2026-01-01", close: 1 }, { date: "2026-01-01", close: 2 }], "eq"), /duplicate date/);

const replayEntry = new Date(`${datedBars.at(-1)!.date}T12:00:00Z`);
replayEntry.setUTCDate(replayEntry.getUTCDate() + 1);
const replayExit = new Date(replayEntry.getTime() + 60 * 60 * 1000);
const syntheticTrades: ClosedTradeInput[] = [
  { symbol: "BTC/USD", side: "LONG", entryTimestamp: replayEntry.toISOString(), exitTimestamp: replayExit.toISOString(), entryPrice: 100, exitPrice: 110, pnlUsd: 10 },
  { symbol: "DOGE-USD", side: "SHORT", entryTimestamp: replayEntry.toISOString(), exitTimestamp: replayExit.toISOString(), entryPrice: 100, exitPrice: 90, pnlUsd: 10 },
];
const syntheticReplay = replayClosedTrades(syntheticTrades, { "BTC-USD": datedBars }, "eq");
assert.deepEqual(syntheticReplay.coverage, { totalTrades: 2, withMarketHistory: 1, withoutMarketHistory: 1, outOfRangeMarketHistory: 0, symbolsTested: ["BTC-USD"], symbolsNotTested: ["DOGE-USD"] });
const staleEntry = new Date(`${datedBars.at(-1)!.date}T12:00:00Z`);
staleEntry.setUTCDate(staleEntry.getUTCDate() + 10);
const staleReplay = replayClosedTrades([{ ...syntheticTrades[0], entryTimestamp: staleEntry.toISOString(), exitTimestamp: new Date(staleEntry.getTime() + 60 * 60 * 1000).toISOString() }], { "BTC-USD": datedBars }, "btc");
assert.equal(staleReplay.coverage.withMarketHistory, 0);
assert.equal(staleReplay.coverage.outOfRangeMarketHistory, 1);
assert.equal(staleReplay.trades[0].status, "market_history_out_of_range");
assert.equal(syntheticReplay.trades[0].priorCloseDate, datedBars.at(-1)!.date);
assert.equal(syntheticReplay.engines.find((engine) => engine.key === "orthrus")?.supportedUserLongs.wins, 1);
assert.equal(syntheticReplay.engines.find((engine) => engine.key === "sisyphus")?.unsupportedUserLongs.trades, 1);
assert.throws(() => replayClosedTrades(syntheticTrades, {}, "invalid" as "btc"), /marketKind/);
const bundledMarketHistory = loadTestingMarketHistory();
assert.equal(Object.keys(bundledMarketHistory.assets).length, 9);
assert.deepEqual(Object.keys(bundledMarketHistory.assets).sort(), ["BTC-USD", "ETH-USD", "GLD", "IWM", "NVDA", "QQQ", "SOL-USD", "SPY", "TLT"]);
assert.match(bundledMarketHistory.assets["BTC-USD"].lastDate, /^\d{4}-\d{2}-\d{2}$/);
assert.ok(
  bundledMarketHistory.assets["BTC-USD"].lastDate >= "2026-09-22",
  `bundled market history must stay current enough for beta trades (got ${bundledMarketHistory.assets["BTC-USD"].lastDate})`,
);
assert.equal(replayClosedTrades(syntheticTrades, historiesFromStore(bundledMarketHistory), marketKindsFromStore(bundledMarketHistory)).coverage.withMarketHistory, 1);

async function accessStatus(user: { id: string; email: string } | null, active: boolean, admin = false): Promise<number> {
  const app = express();
  app.get("/protected", createRequireActiveSubscription({
    databaseReady: () => true,
    currentUser: async () => user,
    entitlementFor: async () => ({ active, status: active ? "active" : null }),
    isAdminEmail: () => admin,
  }), (_req, res) => res.json({ ok: true }));
  const instance = app.listen(0);
  try {
    const address = instance.address();
    assert.ok(address && typeof address === "object");
    return (await fetch(`http://127.0.0.1:${address.port}/protected`)).status;
  } finally {
    await new Promise<void>((resolve, reject) => instance.close((error) => error ? reject(error) : resolve()));
  }
}
assert.equal(await accessStatus(null, false), 401);
assert.equal(await accessStatus({ id: "user", email: "user@example.com" }, false), 403);
assert.equal(await accessStatus({ id: "user", email: "user@example.com" }, true), 200);
assert.equal(await accessStatus({ id: "owner", email: "owner@example.com" }, false, true), 200);
const priorAdminEmails = process.env.ADMIN_EMAILS;
process.env.ADMIN_EMAILS = "owner@example.com, second@example.com";
assert.equal(isAdminEmail(" OWNER@example.com "), true);
assert.equal(isAdminEmail("user@example.com"), false);
if (priorAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
else process.env.ADMIN_EMAILS = priorAdminEmails;

const fixture = process.env.KRAKEN_TRADES_FIXTURE;
if (fixture) {
  const actual = importHistoricalCsv(fs.readFileSync(fixture, "utf8"));
  assert.equal(actual.rows, 112);
  assert.equal(actual.uniqueTransactions, 112);
  assert.deepEqual(actual.pairs, ["BTC/USD", "ETH/USD"]);
}

const paperDirectory = process.env.PAPER_CLOSED_DIR;
let recoveredPaperAccounting: { rows: number; verified: number; mismatched: number; missing: number; invalid: number } | undefined;
let recoveredTrades: ClosedTradeInput[] | undefined;
if (paperDirectory) {
  const files = fs.readdirSync(paperDirectory).filter((name) => name === "paper_positions_closed.jsonl");
  // The environment points at one asset directory when used directly; the regular test command uses the parent below.
  if (files.length) assert.ok(validateClosedPaperTradesJsonl(fs.readFileSync(`${paperDirectory}/${files[0]}`, "utf8")).rows > 0);
  else {
    const paperFiles = fs.readdirSync(paperDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && fs.existsSync(`${paperDirectory}/${entry.name}/paper_positions_closed.jsonl`))
      .map((entry) => fs.readFileSync(`${paperDirectory}/${entry.name}/paper_positions_closed.jsonl`, "utf8"));
    const reports = paperFiles.map((contents) => validateClosedPaperTradesJsonl(contents));
    recoveredTrades = paperFiles.flatMap((contents) => parseClosedTradesJsonl(contents));
    recoveredPaperAccounting = {
      rows: reports.reduce((sum, report) => sum + report.rows, 0),
      verified: reports.reduce((sum, report) => sum + report.verifiedAccounting, 0),
      mismatched: reports.reduce((sum, report) => sum + report.mismatchedAccounting, 0),
      missing: reports.reduce((sum, report) => sum + report.missingAccountingFields, 0),
      invalid: reports.reduce((sum, report) => sum + report.invalidRows, 0),
    };
    assert.equal(recoveredPaperAccounting.rows, 194);
    assert.equal(recoveredPaperAccounting.invalid, 0);
    assert.equal(
      recoveredPaperAccounting.verified + recoveredPaperAccounting.mismatched + recoveredPaperAccounting.missing,
      recoveredPaperAccounting.rows,
    );
  }
}

const engineMarketDataDirectory = process.env.ENGINE_MARKET_DATA_DIR;
let recoveredEngineParity: { assets: number; signals: number } | undefined;
let recoveredTradeReplay: ReturnType<typeof replayClosedTrades> | undefined;
if (engineMarketDataDirectory) {
  const expected: Record<string, { kind: "eq" | "btc"; rows: number; hashes: Record<"orthrus" | "hydra" | "sisyphus", string> }> = {
    SPY: { kind: "eq", rows: 3139, hashes: { orthrus: "fff51c5a98e3241f3964da96a20cde0c84104c4f1f921432dde1fb63cdddb7ef", hydra: "26820a4499ba6f70acefb2530c2a74c7ebd76e09e2c8a8c8b7e21ba86a4d8ea0", sisyphus: "b41d8d78396218196df88a77de03571eddc8a9b73aa1d60c5c54016547e8e3b9" } },
    QQQ: { kind: "eq", rows: 3139, hashes: { orthrus: "33514783c93d31fdf5ea6f5678f765080e1eaae7e0b7626917e1102587f8f940", hydra: "139534904f99f04c5e579c82992e2decc07ce26b7c7fda250d6a5e72aa160c74", sisyphus: "245b9fe279efb0d444e12cdb019c9e12b2485cbdeb314809421667fce366abdf" } },
    NVDA: { kind: "eq", rows: 3139, hashes: { orthrus: "93560a9facabe16afaa50a7cc13ad8361dd67b0bef56301de596af22ce1ddb97", hydra: "5a2f1c3a76e77b7ef0ff27b56d3ee62f20f712aa8e8e559d735acb32a6ff79e8", sisyphus: "53d5d48cac70cd90b87ca186a72f8be59295c99107b682f2398e811564bc0085" } },
    GLD: { kind: "eq", rows: 3139, hashes: { orthrus: "84c9cd0b17cee12099de2f61d433ba1e059aa6ca46a9a4f8ba80b2f2359af64f", hydra: "cedc00f50b545a27cafbe85eae08c149d977b6eeda951e92812b99f64f850f64", sisyphus: "79c9612b8e384dd1bec6d7fd36dd62b49c66799e6973abc466ca2cffa139f35b" } },
    IWM: { kind: "eq", rows: 3139, hashes: { orthrus: "c9b829c82b551b2aa7a093b22b16fa24f21955de0de9460b95c0102fe40fdda4", hydra: "c422746da49150778988ede601193a52d170d764907b6ce25a54aa6bc494ebe5", sisyphus: "543c3681d3a63d9132e92416deaa73e19d5a6210d288f0e543cd878d7a0e6cd2" } },
    TLT: { kind: "eq", rows: 3138, hashes: { orthrus: "640443a682d00d46b95a008d80eedb25629ba81cd3174387fa50e388bdc0f793", hydra: "0c291e3f4016ab800d406646d611de9f93c86e018c6334a61e604c13adddfc08", sisyphus: "338e6fffdaab29d15fdac76e4932660f3f13d2d298bfc5dbe5fa2d4fdd979d6f" } },
    "BTC-USD": { kind: "btc", rows: 4301, hashes: { orthrus: "486a08a61c8c91a80c1ba21eaf602ab22ada5441c481575c415fe2dbd16d01ae", hydra: "3565d1c64e93c2f499a84fcf4d824ddcd2438773e4ed8ac7961c099894aa9205", sisyphus: "803146553b1257d9f9ce64fa6dfbd7805d2c6b949462fc868b0c828851300607" } },
  };
  for (const [asset, reference] of Object.entries(expected)) {
    const lines = fs.readFileSync(`${engineMarketDataDirectory}/${asset}.csv`, "utf8").trim().split(/\r?\n/);
    const adjustedCloseIndex = lines[0].split(",").indexOf("Adj Close");
    assert.notEqual(adjustedCloseIndex, -1);
    const closes = lines.slice(1).map((line) => Number(line.split(",")[adjustedCloseIndex]));
    assert.equal(closes.length, reference.rows);
    const signals = calculateFrozenEngineSignals(closes, reference.kind);
    for (const key of ["orthrus", "hydra", "sisyphus"] as const) {
      const hash = createHash("sha256").update(signals[key].join("")).digest("hex");
      assert.equal(hash, reference.hashes[key], `${asset} ${key} differs from the recovered Python reference`);
    }
  }
  recoveredEngineParity = { assets: Object.keys(expected).length, signals: Object.keys(expected).length * 3 };
  if (recoveredTrades) {
    const histories = Object.fromEntries(["BTC-USD", "ETH-USD", "SOL-USD"].map((asset) => {
      const lines = fs.readFileSync(`${engineMarketDataDirectory}/${asset}.csv`, "utf8").trim().split(/\r?\n/);
      const headers = lines[0].split(",");
      const dateIndex = headers.indexOf("Date"), closeIndex = headers.indexOf("Adj Close");
      return [asset, lines.slice(1).map((line) => {
        const cells = line.split(",");
        return { date: cells[dateIndex], close: Number(cells[closeIndex]) };
      })];
    }));
    recoveredTradeReplay = replayClosedTrades(recoveredTrades, histories, "btc");
    assert.equal(recoveredTradeReplay.coverage.totalTrades, 194);
    assert.equal(recoveredTradeReplay.coverage.withMarketHistory, 78);
    assert.equal(recoveredTradeReplay.coverage.withoutMarketHistory, 116);
  }
}

const testApp = express();
testApp.use(express.text({ type: "text/csv" }));
testApp.use(express.json());
testApp.use("/api", testingHarnessRouter);
testApp.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = err && typeof err === "object" && "statusCode" in err ? Number(err.statusCode) : 500;
  res.status(status).json({ ok: false });
});
const server = testApp.listen(0);
try {
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${base}/api/testing-harness/import`, {
    method: "POST", headers: { "content-type": "text/csv" }, body: sample,
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { rows: number; executionCapable: boolean };
  assert.equal(body.rows, 3);
  assert.equal(body.executionCapable, false);

  const invalid = await fetch(`${base}/api/testing-harness/import`, {
    method: "POST", headers: { "content-type": "text/csv" }, body: "txid,time\nT1,2026-01-01",
  });
  assert.equal(invalid.status, 400);

  const engineResponse = await fetch(`${base}/api/testing-harness/engines/evaluate`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketKind: "eq", bars: datedBars }),
  });
  assert.equal(engineResponse.status, 503);

  const invalidEngine = await fetch(`${base}/api/testing-harness/engines/evaluate`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ marketKind: "eq", bars: [{ date: "bad", close: 1 }] }),
  });
  assert.equal(invalidEngine.status, 503);

  const replayResponse = await fetch(`${base}/api/testing-harness/replay`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ trades: syntheticTrades, histories: { "ATTACKER-SUPPLIED": datedBars } }),
  });
  assert.equal(replayResponse.status, 503);

  const templateResponse = await fetch(`${base}/api/testing-harness/template`);
  assert.equal(templateResponse.status, 200);
  assert.equal((await templateResponse.text()).trim(), "symbol,side,entry_timestamp_utc,exit_timestamp_utc,entry_price,exit_price,pnl_usd");
} finally {
  await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
}

console.log(JSON.stringify({
  ok: true,
  checks: ["synthetic-import", "validation-errors", "private-fixture", "paper-accounting", "frozen-engine-parity", "trade-replay", "bundled-market-history", "subscription-access", "engine-http-route", "replay-http-route", "http-route", "historical-only-boundary"],
  recoveredPaperAccounting,
  recoveredEngineParity,
  recoveredTradeReplay: recoveredTradeReplay ? {
    coverage: recoveredTradeReplay.coverage,
    testedTradeProfile: recoveredTradeReplay.testedTradeProfile,
    engines: recoveredTradeReplay.engines,
  } : undefined,
}));
