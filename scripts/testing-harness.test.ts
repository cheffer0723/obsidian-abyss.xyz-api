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
assert.equal(parsed.rows, the_rest_placeholder