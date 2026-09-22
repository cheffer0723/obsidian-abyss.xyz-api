import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
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

type MarketHistoryDelta = {
  generatedAt?: string;
  assets: Record<string, {
    lastDate: string;
    sourceSha256?: string;
    bars: HistoricalClose[];
  }>;
};

let cached: TestingMarketHistory | null = null;

function loadDelta(deltaPath: string): MarketHistoryDelta | null {
  if (!fs.existsSync(deltaPath)) return null;
  const raw = fs.readFileSync(deltaPath, "utf8").trim();
  try {
    if (deltaPath.endsWith(".b64")) {
      const buf = zlib.gunzipSync(Buffer.from(raw, "base64"));
      return JSON.parse(buf.toString("utf8")) as MarketHistoryDelta;
    }
    return JSON.parse(raw) as MarketHistoryDelta;
  } catch {
    return null;
  }
}

function applyDelta(base: TestingMarketHistory, delta: MarketHistoryDelta): TestingMarketHistory {
  if (!delta?.assets || typeof delta.assets !== "object") return base;
  const assets: TestingMarketHistory["assets"] = { ...base.assets };
  for (const [symbol, patch] of Object.entries(delta.assets)) {
    const current = assets[symbol];
    if (!current || !patch?.bars?.length) continue;
    const seen = new Set(current.bars.map((b) => b.date));
    const merged = current.bars.slice();
    for (const bar of patch.bars) {
      if (!seen.has(bar.date)) {
        merged.push(bar);
        seen.add(bar.date);
      }
    }
    merged.sort((a, b) => a.date.localeCompare(b.date));
    assets[symbol] = {
      ...current,
      sourceSha256: patch.sourceSha256 || current.sourceSha256,
      lastDate: patch.lastDate || merged[merged.length - 1]?.date || current.lastDate,
      firstDate: merged[0]?.date || current.firstDate,
      bars: merged,
    };
  }
  return {
    ...base,
    generatedAt: delta.generatedAt || base.generatedAt,
    assets,
  };
}

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
  const dir = path.dirname(filename);
  const delta =
    loadDelta(path.join(dir, "market-history.delta.b64")) ||
    loadDelta(path.join(dir, "market-history.delta.json"));
  if (delta) parsed = applyDelta(parsed, delta);
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
