import fs from "node:fs";
import path from "node:path";
import type { HistoricalClose, MarketKind } from "./frozen-engines.js";

export interface TestingMarketHistory {
  generatedAt: string;
  purpose: "historical_testing_only";
  source: string;
  assets: Record<string, {
    kind: MarketKind;
    sourceSha256: string;
    firstDate: string;
    lastDate: string;
    bars: HistoricalClose[];
  }>;
}

let cached: TestingMarketHistory | null = null;

export function loadTestingMarketHistory(): TestingMarketHistory {
  if (cached) return cached;
  const configured = String(process.env.TESTING_MARKET_HISTORY_FILE || "").trim();
  const filename = configured || path.resolve(process.cwd(), "data/testing-harness/market-history.json");
  let parsed: TestingMarketHistory;
  try {
    parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as TestingMarketHistory;
  } catch {
    throw serviceError("Historical market data is not available.");
  }
  if (parsed?.purpose !== "historical_testing_only" || !parsed.assets || typeof parsed.assets !== "object") {
    throw serviceError("Historical market data failed validation.");
  }
  cached = parsed;
  return parsed;
}

export function historiesFromStore(store: TestingMarketHistory): Record<string, HistoricalClose[]> {
  return Object.fromEntries(Object.entries(store.assets).map(([symbol, asset]) => [symbol, asset.bars]));
}

export function marketKindsFromStore(store: TestingMarketHistory): Record<string, MarketKind> {
  return Object.fromEntries(Object.entries(store.assets).map(([symbol, asset]) => [symbol, asset.kind]));
}

function serviceError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 503 });
}
