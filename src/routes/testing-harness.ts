import { Router } from "express";
import { importHistoricalCsv } from "../lib/testing-harness.js";
import { evaluateFrozenEngines, type HistoricalClose, type MarketKind } from "../lib/frozen-engines.js";
import { replayClosedTrades, type ClosedTradeInput } from "../lib/trade-replay.js";

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

router.post("/testing-harness/engines/evaluate", (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object" ? req.body as { marketKind?: unknown; bars?: unknown } : {};
    res.json(evaluateFrozenEngines(body.bars as HistoricalClose[], body.marketKind as MarketKind));
  } catch (error) {
    next(error);
  }
});

router.post("/testing-harness/replay", (req, res, next) => {
  try {
    const body = req.body && typeof req.body === "object"
      ? req.body as { trades?: unknown; histories?: unknown; marketKind?: unknown }
      : {};
    res.json(replayClosedTrades(
      body.trades as ClosedTradeInput[],
      body.histories as Record<string, HistoricalClose[]>,
      (body.marketKind || "btc") as MarketKind,
    ));
  } catch (error) {
    next(error);
  }
});

export default router;
