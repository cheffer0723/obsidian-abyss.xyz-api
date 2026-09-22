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

let cached: TestingMarketHistory | null = null;

function defaultDataDir(): string {
  return path.resolve(process.cwd(), "data/testing-harness");
}

function decodeBase64Parts(texts: string[]): Buffer {
  return Buffer.concat(texts.map((text) => Buffer.from(text.replace(/\s+/g, ""), "base64")));
}

function assembleCompressedFromShardMap(shardMap: Map<string, string>): Buffer {
  const groups = new Map<string, string[]>();
  for (const name of shardMap.keys()) {
    const key = name.replace(/\.\d+$/, "");
    const list = groups.get(key) || [];
    list.push(name);
    groups.set(key, list);
  }
  const texts: string[] = [];
  for (const key of [...groups.keys()].sort()) {
    const shards = (groups.get(key) || []).sort((a, b) => {
      const ai = Number(a.slice(a.lastIndexOf(".") + 1));
      const bi = Number(b.slice(b.lastIndexOf(".") + 1));
      return ai - bi;
    });
    texts.push(shards.map((name) => shardMap.get(name) || "").join(""));
  }
  return decodeBase64Parts(texts);
}

function loadShardMapFromPacks(directory: string): Map<string, string> | null {
  const packsDir = path.join(directory, "shard-packs");
  if (!fs.existsSync(packsDir)) return null;
  const packs = fs.readdirSync(packsDir).filter((name) => name.endsWith(".json")).sort();
  if (!packs.length) return null;
  const shardMap = new Map<string, string>();
  for (const pack of packs) {
    const parsed = JSON.parse(fs.readFileSync(path.join(packsDir, pack), "utf8")) as Record<string, string>;
    for (const [name, content] of Object.entries(parsed)) shardMap.set(name, content);
  }
  return shardMap.size ? shardMap : null;
}

function loadFromParts(directory: string): TestingMarketHistory {
  const partsDir = path.join(directory, "market-history.parts");
  const names = fs.existsSync(partsDir) ? fs.readdirSync(partsDir) : [];

  // Prefer MCP-friendly base64 shards: NNN.gz.part.b64.SS
  const shardNames = names.filter((name) => /\.gz\.part\.b64\.\d+$/.test(name)).sort();
  let compressed: Buffer;
  if (shardNames.length) {
    const shardMap = new Map<string, string>();
    for (const name of shardNames) {
      shardMap.set(name, fs.readFileSync(path.join(partsDir, name), "utf8"));
    }
    compressed = assembleCompressedFromShardMap(shardMap);
  } else {
    const fromPacks = loadShardMapFromPacks(directory);
    if (fromPacks) {
      compressed = assembleCompressedFromShardMap(fromPacks);
    } else {
      // Prefer full base64 text parts; fall back to raw binary .gz.part chunks.
      const b64Parts = names.filter((name) => name.endsWith(".gz.part.b64")).sort();
      if (b64Parts.length) {
        compressed = decodeBase64Parts(b64Parts.map((name) => fs.readFileSync(path.join(partsDir, name), "utf8")));
      } else {
        const parts = names.filter((name) => name.endsWith(".gz.part")).sort();
        if (!parts.length) throw serviceError("Historical market data is not available.");
        compressed = Buffer.concat(parts.map((name) => fs.readFileSync(path.join(partsDir, name))));
      }
    }
  }

  const parsed = JSON.parse(zlib.gunzipSync(compressed).toString("utf8")) as TestingMarketHistory;
  if (parsed?.purpose !== "historical_testing_only" || !parsed.assets || typeof parsed.assets !== "object") {
    throw serviceError("Historical market data failed validation.");
  }
  return parsed;
}

function loadFromJsonFile(filename: string): TestingMarketHistory {
  const parsed = JSON.parse(fs.readFileSync(filename, "utf8")) as TestingMarketHistory;
  if (parsed?.purpose !== "historical_testing_only" || !parsed.assets || typeof parsed.assets !== "object") {
    throw serviceError("Historical market data failed validation.");
  }
  return parsed;
}

export function loadTestingMarketHistory(): TestingMarketHistory {
  if (cached) return cached;
  const configured = String(process.env.TESTING_MARKET_HISTORY_FILE || "").trim();
  const directory = defaultDataDir();
  let parsed: TestingMarketHistory;
  try {
    if (configured) {
      parsed = loadFromJsonFile(configured);
    } else {
      const monolithic = path.join(directory, "market-history.json");
      // Prefer assembled parts/packs so the large snapshot can ship in git-friendly chunks.
      const partsDir = path.join(directory, "market-history.parts");
      const packsDir = path.join(directory, "shard-packs");
      if (fs.existsSync(partsDir) || fs.existsSync(packsDir)) parsed = loadFromParts(directory);
      else parsed = loadFromJsonFile(monolithic);
    }
  } catch (error) {
    if (error && typeof error === "object" && "statusCode" in error) throw error;
    throw serviceError("Historical market data is not available.");
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
