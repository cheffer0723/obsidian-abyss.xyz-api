import { Router } from "express";
import { importHistoricalCsv } from "../lib/testing-harness.js";
import { evaluateFrozenEngines, type HistoricalClose, type MarketKind } from "../lib/frozen-engines.js";
import { CLOSED_TRADE_CSV_HEADER, parseClosedTradesCsv, replayClosedTrades, type ClosedTradeInput } from "../lib/trade-replay.js";
import { requireActiveSubscription } from "../lib/access.js";
import { historiesFromStore, loadTestingMarketHistory, marketKindsFromStore } from "../lib/testing-market-history.js";
import { recordMetricEvent } from "../lib/account.js";

const router = Router();

// Historical analysis only. This route has no exchange credentials or execution path.
router.post("/testing-harness/import", (req, res, next) => {
  try {
    const csv = typeof req.body === "string"
      ? req.body
      : req.body && typeof req.body === "object" && typeof req.body.csv === "string"
        ? req.body.csv
        : "";
    res.json(importHistoricalCsv(csv));
  } catch (error) {
    next(error);
  }
});

router.post("/testing-harness/engines/evaluate", requireActiveSubscription, (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body as { marketKind?: unknown; bars?: unknown } : {};
    res.json(evaluateFrozenEngines(body.bars as HistoricalClose[], body.marketKind as MarketKind));
  } catch (error) {
    next(error);
  }
});

router.post("/testing-harness/replay", requireActiveSubscription, (req, res, next) => {
  const startedAt = Date.now();
  try {
    const body = req.body && typeof req.body === "object" ? req.body as { trades?: unknown; csv?: unknown } : {};
    const trades = typeof req.body === "string"
      ? parseClosedTradesCsv(req.body)
      : typeof body.csv === "string"
        ? parseClosedTradesCsv(body.csv)
        : body.trades as ClosedTradeInput[];
    const store = loadTestingMarketHistory();
    const replay = replayClosedTrades(
      trades,
      historiesFromStore(store),
      marketKindsFromStore(store),
    );
    void recordMetricEvent({
      eventType: "harness_replay",
      outcome: "success",
      durationMs: Date.now() - startedAt,
      tradeCount: replay.coverage.totalTrades,
      matchedTradeCount: replay.coverage.withMarketHistory,
      metadata: {
        outOfRangeTrades: replay.coverage.outOfRangeMarketHistory,
        symbolsTested: replay.coverage.symbolsTested.length,
        engineSamples: replay.engines.map((engine) => ({ key: engine.key, eligibleTrades: engine.eligibleTrades, longContextTrades: engine.longContextTrades })),
      },
    });
    res.json(replay);
  } catch (error) {
    void recordMetricEvent({
      eventType: "harness_replay",
      outcome: "rejected",
      durationMs: Date.now() - startedAt,
      metadata: { reason: error && typeof error === "object" && "statusCode" in error && Number((error as { statusCode?: unknown }).statusCode) === 400 ? "validation" : "service" },
    });
    next(error);
  }
});

router.get("/testing-harness/template", (_req, res) => {
  res.type("text/csv").send(`${CLOSED_TRADE_CSV_HEADER}\n`);
});

export default router;
