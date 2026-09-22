import fs from "node:fs";
import path from "node:path";
import type { HistoricalClose, MarketKind } from "./frozen-engines.js";
import { logger } from "./logger.js";

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

const DEFAULT_FEED_URL = "https://obsidianabyss.com/harness/market-history.json";
const FALLBACK_FEED_URL =
  "https://raw.githubusercontent.com/cheffer0723/obsidian-abyss.xyz-site/main/public/harness/market-history.json";

let cached: TestingMarketHistory | null = null;
let warmPromise: Promise<void> | null = null;

function cachePath(): string {
  const configured = String(process.env.TESTING_MARKET_HISTORY_FILE || "").trim();
  return configured || path.resolve(process.cwd(), "data/testing-harness/market-history.json");
}

function parseHistory(raw: string): TestingMarketHistory {
  const parsed = JSON.parse(raw) as TestingMarketHistory;
  if (parsed?.purpose !== "historical_testing_only" || !parsed.assets || typeof parsed.assets !== "object") {
    throw serviceError("Historical market data failed validation.");
  }
  return parsed;
}

export function loadTestingMarketHistory(): TestingMarketHistory {
  if (cached) return cached;
  const filename = cachePath();
  try {
    cached = parseHistory(fs.readFileSync(filename, "utf8"));
    return cached;
  } catch {
    throw serviceError("Historical market data is not available.");
  }
}

/**
 * Ensure the harness market snapshot is on disk. Prefers a local file, otherwise
 * downloads the published research feed (not a live signal stream).
 */
export async function warmTestingMarketHistory(): Promise<void> {
  if (cached) return;
  if (warmPromise) return warmPromise;
  warmPromise = (async () => {
    const filename = cachePath();
    if (fs.existsSync(filename)) {
      cached = parseHistory(fs.readFileSync(filename, "utf8"));
      return;
    }
    const candidates = [
      String(process.env.TESTING_MARKET_HISTORY_URL || "").trim(),
      DEFAULT_FEED_URL,
      FALLBACK_FEED_URL,
    ].filter(Boolean);
    let lastError: unknown = null;
    for (const url of candidates) {
      try {
        const response = await fetch(url, { headers: { "user-agent": "ObsidianAbyssHarness/1.0" } });
        if (!response.ok) {
          lastError = new Error(`feed ${url} -> ${response.status}`);
          continue;
        }
        const raw = await response.text();
        const parsed = parseHistory(raw);
        fs.mkdirSync(path.dirname(filename), { recursive: true });
        fs.writeFileSync(filename, raw.endsWith("\n") ? raw : `${raw}\n`);
        cached = parsed;
        logger.info({
          feedUrl: url,
          assets: Object.keys(parsed.assets).length,
          spyLastDate: parsed.assets.SPY?.lastDate,
        }, "Loaded published harness market history");
        return;
      } catch (error) {
        lastError = error;
      }
    }
    logger.warn({ error: lastError instanceof Error ? lastError.message : String(lastError) }, "Harness market history download failed");
    throw serviceError("Historical market data is not available.");
  })();
  try {
    await warmPromise;
  } finally {
    warmPromise = null;
  }
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
