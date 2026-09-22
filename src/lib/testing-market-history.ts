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

function readDeltaB64(dir: string): string | null {
  const p0 = path.join(dir, "market-history.delta.b64.0");
  const p1 = path.join(dir, "market-history.delta.b64.1");
  if (fs.existsSync(p0) && fs.existsSync(p1)) {
    return (fs.readFileSync(p0, "utf8") + fs.readFileSync(p1, "utf8")).trim();
  }
  const single = path.join(dir, "market-history.delta.b64");
  if (fs.existsSync(single)) return fs.readFileSync(single, "utf8").trim();
  return null;
}

function loadDelta(dir: string): MarketHistoryDelta | null {
  try {
    const b64 = readDeltaB64(dir);
    if (b64) {
      const buf = zlib.gunzipSync(Buffer.from(b64, "base64"));
      return JSON.parse(buf.toString("utf8")) as MarketHistoryDelta;
    }
    const jsonPath = path.join(dir, "market-history.delta.json");
    if (fs.existsSync(jsonPath)) {
      return JSON.parse(fs.readFileSync(jsonPath, "utf8")) as MarketHistoryDelta;
    }
  } catch {
    return null;
  }
  return null;
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
  const delta = loadDelta(path.dirname(filename));
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
