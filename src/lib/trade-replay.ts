import { calculateFrozenEngineSignals, FROZEN_ENGINES, FROZEN_ENGINE_SOURCE, type BinarySignal, type FrozenEngineKey, type HistoricalClose, type MarketKind } from "./frozen-engines.js";
import { parseCsvRows } from "./testing-harness.js";

export interface ClosedTradeInput {
  symbol: string;
  side: "LONG" | "SHORT";
  entryTimestamp: string;
  exitTimestamp: string;
  entryPrice: number;
  exitPrice: number;
  pnlUsd: number;
}

type EngineRelationship = "supports_user_long" | "does_not_support_user_long" | "conflicts_with_user_short" | "no_short_opinion";

export interface HistoricalTradeReplay {
  ok: true;
  purpose: "historical_testing_only";
  executionCapable: false;
  source: typeof FROZEN_ENGINE_SOURCE;
  limits: string[];
  coverage: { totalTrades: number; withMarketHistory: number; withoutMarketHistory: number; symbolsTested: string[]; symbolsNotTested: string[] };
  testedTradeProfile: {
    trades: number;
    wins: number;
    winRatePct: number | null;
    netPnlUsd: number;
    medianHoldingMinutes: number | null;
    distinctPriorCloseDates: number;
    distinctSymbolDateContexts: number;
    longs: { trades: number; wins: number; winRatePct: number | null; netPnlUsd: number };
    shorts: { trades: number; wins: number; winRatePct: number | null; netPnlUsd: number };
  };
  engines: Array<{
    key: FrozenEngineKey;
    name: string;
    eligibleTrades: number;
    insufficientHistory: number;
    longContextTrades: number;
    cashContextTrades: number;
    longContextMoveUp: number;
    longContextMoveDown: number;
    longContextDirectionalAccuracyPct: number | null;
    supportedUserLongs: { trades: number; wins: number; winRatePct: number | null; netPnlUsd: number };
    unsupportedUserLongs: { trades: number; wins: number; winRatePct: number | null; netPnlUsd: number };
    userShortContext: { longSignalConflicts: number; cashMeansNoShortOpinion: number };
  }>;
  trades: Array<{
    index: number;
    symbol: string;
    side: "LONG" | "SHORT";
    entryTimestamp: string;
    exitTimestamp: string;
    holdingMinutes: number;
    pnlUsd: number;
    outcome: "win" | "loss" | "flat";
    marketMovePct: number;
    status: "evaluated" | "no_market_history";
    priorCloseDate: string | null;
    engines: Array<{
      key: FrozenEngineKey;
      signal: "long" | "cash" | "insufficient_history";
      relationship: EngineRelationship | null;
    }>;
  }>;
}

export function parseClosedTradesJsonl(jsonlText: string): ClosedTradeInput[] {
  const trades: ClosedTradeInput[] = [];
  for (const [lineIndex, line] of String(jsonlText || "").split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; }
    catch { throw inputError(`JSONL line ${lineIndex + 1} is not valid JSON.`); }
    if (String(row.status || "").toUpperCase() !== "CLOSED") throw inputError(`JSONL line ${lineIndex + 1} is not a closed trade.`);
    const side = String(row.side || "").toUpperCase();
    if (side !== "LONG" && side !== "SHORT") throw inputError(`JSONL line ${lineIndex + 1} side must be LONG or SHORT.`);
    const entryTimestamp = timestamp(row.entry_timestamp_utc, "entry_timestamp_utc", lineIndex + 1);
    const exitTimestamp = timestamp(row.exit_timestamp_utc, "exit_timestamp_utc", lineIndex + 1);
    if (Date.parse(exitTimestamp) < Date.parse(entryTimestamp)) throw inputError(`JSONL line ${lineIndex + 1} exits before it enters.`);
    trades.push({
      symbol: normalizeSymbol(required(row.symbol, "symbol", lineIndex + 1)),
      side,
      entryTimestamp,
      exitTimestamp,
      entryPrice: positive(row.entry_price, "entry_price", lineIndex + 1),
      exitPrice: positive(row.exit_price, "exit_price", lineIndex + 1),
      pnlUsd: finite(row.pnl_usd, "pnl_usd", lineIndex + 1),
    });
  }
  if (!trades.length) throw inputError("No closed trades were provided.");
  return trades;
}

export const CLOSED_TRADE_CSV_HEADER = "symbol,side,entry_timestamp_utc,exit_timestamp_utc,entry_price,exit_price,pnl_usd";

export function parseClosedTradesCsv(csvText: string): ClosedTradeInput[] {
  const rows = parseCsvRows(csvText);
  if (rows.length < 2) throw inputError("CSV must contain a header and at least one completed trade.");
  const headers = rows[0].map((value) => value.trim().toLowerCase());
  const indexes = new Map(headers.map((header, index) => [header, index]));
  const requiredFields = CLOSED_TRADE_CSV_HEADER.split(",");
  const missing = requiredFields.filter((field) => !indexes.has(field));
  if (missing.length) throw inputError(`Completed-trade CSV fields missing: ${missing.join(", ")}.`);
  const asJsonl = rows.slice(1).map((cells) => JSON.stringify({
    status: "CLOSED",
    symbol: cells[indexes.get("symbol")!],
    side: cells[indexes.get("side")!],
    entry_timestamp_utc: cells[indexes.get("entry_timestamp_utc")!],
    exit_timestamp_utc: cells[indexes.get("exit_timestamp_utc")!],
    entry_price: cells[indexes.get("entry_price")!],
    exit_price: cells[indexes.get("exit_price")!],
    pnl_usd: cells[indexes.get("pnl_usd")!],
  })).join("\n");
  return parseClosedTradesJsonl(asJsonl);
}

export function replayClosedTrades(
  trades: readonly ClosedTradeInput[],
  histories: Readonly<Record<string, readonly HistoricalClose[]>>,
  marketKinds: MarketKind | Readonly<Record<string, MarketKind>> = "btc",
): HistoricalTradeReplay {
  if (!Array.isArray(trades) || !trades.length) throw inputError("trades must contain at least one closed trade.");
  if (typeof marketKinds === "string" && marketKinds !== "eq" && marketKinds !== "btc") throw inputError("marketKind must be eq or btc.");
  const prepared = new Map<string, PreparedHistory>();
  for (const [rawSymbol, bars] of Object.entries(histories || {})) {
    const symbol = normalizeSymbol(rawSymbol);
    const kind = typeof marketKinds === "string" ? marketKinds : marketKinds[symbol];
    if (kind !== "eq" && kind !== "btc") throw inputError(`Market kind for ${symbol} must be eq or btc.`);
    prepared.set(symbol, prepareHistory(symbol, bars, kind));
  }

  const symbolsTested = new Set<string>(), symbolsNotTested = new Set<string>();
  const tradeResults: HistoricalTradeReplay["trades"] = [];
  for (const [index, trade] of trades.entries()) {
    validateTrade(trade, index);
    const symbol = normalizeSymbol(trade.symbol);
    const history = prepared.get(symbol);
    const marketMovePct = round((trade.exitPrice / trade.entryPrice - 1) * 100, 6);
    const holdingMinutes = round((Date.parse(trade.exitTimestamp) - Date.parse(trade.entryTimestamp)) / 60_000, 3);
    if (!history) {
      symbolsNotTested.add(symbol);
      tradeResults.push({
        index, symbol, side: trade.side, entryTimestamp: trade.entryTimestamp, exitTimestamp: trade.exitTimestamp,
        holdingMinutes, pnlUsd: round(trade.pnlUsd, 8), outcome: outcome(trade.pnlUsd), marketMovePct,
        status: "no_market_history", priorCloseDate: null, engines: [],
      });
      continue;
    }
    symbolsTested.add(symbol);
    const entryDay = new Date(trade.entryTimestamp).toISOString().slice(0, 10);
    const barIndex = latestStrictlyEarlierDate(history.bars, entryDay);
    const readings = FROZEN_ENGINES.map((engine) => {
      if (barIndex < engine.warmupBars(history.kind)) return { key: engine.key, signal: "insufficient_history" as const, relationship: null };
      const signal = history.signals[engine.key][barIndex];
      return { key: engine.key, signal: signal ? "long" as const : "cash" as const, relationship: relationship(trade.side, signal) };
    });
    tradeResults.push({
      index, symbol, side: trade.side, entryTimestamp: trade.entryTimestamp, exitTimestamp: trade.exitTimestamp,
      holdingMinutes, pnlUsd: round(trade.pnlUsd, 8), outcome: outcome(trade.pnlUsd), marketMovePct,
      status: "evaluated", priorCloseDate: barIndex >= 0 ? history.bars[barIndex].date : null, engines: readings,
    });
  }

  const testedTrades = tradeResults.filter((trade) => trade.status === "evaluated");
  return {
    ok: true,
    purpose: "historical_testing_only",
    executionCapable: false,
    source: FROZEN_ENGINE_SOURCE,
    limits: [
      "These engines provide daily long-or-cash context; they do not issue short signals.",
      "Each trade uses the latest daily close from a strictly earlier calendar date.",
      "A correct long-context direction over a user-chosen holding period is not a complete engine backtest or proof of predictive edge.",
      "Trades without matching market history are reported as not tested and excluded from engine percentages.",
    ],
    coverage: {
      totalTrades: tradeResults.length,
      withMarketHistory: tradeResults.filter((trade) => trade.status === "evaluated").length,
      withoutMarketHistory: tradeResults.filter((trade) => trade.status === "no_market_history").length,
      symbolsTested: [...symbolsTested].sort(),
      symbolsNotTested: [...symbolsNotTested].sort(),
    },
    testedTradeProfile: {
      ...summarizeTradeGroup(testedTrades),
      medianHoldingMinutes: median(testedTrades.map((trade) => trade.holdingMinutes)),
      distinctPriorCloseDates: new Set(testedTrades.map((trade) => trade.priorCloseDate).filter(Boolean)).size,
      distinctSymbolDateContexts: new Set(testedTrades.map((trade) => `${trade.symbol}|${trade.priorCloseDate}`)).size,
      longs: summarizeTradeGroup(testedTrades.filter((trade) => trade.side === "LONG")),
      shorts: summarizeTradeGroup(testedTrades.filter((trade) => trade.side === "SHORT")),
    },
    engines: FROZEN_ENGINES.map((engine) => summarizeEngine(engine.key, engine.name, tradeResults)),
    trades: tradeResults,
  };
}

function summarizeTradeGroup(trades: HistoricalTradeReplay["trades"]): { trades: number; wins: number; winRatePct: number | null; netPnlUsd: number } {
  const wins = trades.filter((trade) => trade.outcome === "win").length;
  return {
    trades: trades.length,
    wins,
    winRatePct: trades.length ? round(wins / trades.length * 100, 2) : null,
    netPnlUsd: round(trades.reduce((sum, trade) => sum + trade.pnlUsd, 0), 8),
  };
}

interface PreparedHistory {
  bars: readonly HistoricalClose[];
  kind: MarketKind;
  signals: Record<FrozenEngineKey, BinarySignal[]>;
}

function prepareHistory(symbol: string, bars: readonly HistoricalClose[], kind: MarketKind): PreparedHistory {
  if (!Array.isArray(bars) || !bars.length) throw inputError(`Market history for ${symbol} is empty.`);
  let previous = "";
  for (const [index, bar] of bars.entries()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(bar?.date || "")) || Number.isNaN(Date.parse(`${bar.date}T00:00:00Z`))) {
      throw inputError(`Market history for ${symbol} has an invalid date at row ${index + 1}.`);
    }
    if (bar.date <= previous) throw inputError(`Market history for ${symbol} must be sorted with unique dates.`);
    previous = bar.date;
  }
  return { bars, kind, signals: calculateFrozenEngineSignals(bars.map((bar) => bar.close), kind) };
}

function latestStrictlyEarlierDate(bars: readonly HistoricalClose[], entryDay: string): number {
  let low = 0, high = bars.length - 1, found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (bars[middle].date < entryDay) { found = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return found;
}

function summarizeEngine(key: FrozenEngineKey, name: string, trades: HistoricalTradeReplay["trades"]): HistoricalTradeReplay["engines"][number] {
  const readings = trades.flatMap((trade) => {
    const reading = trade.engines.find((candidate) => candidate.key === key);
    return reading ? [{ trade, reading }] : [];
  });
  const eligible = readings.filter(({ reading }) => reading.signal !== "insufficient_history");
  const longContext = eligible.filter(({ reading }) => reading.signal === "long");
  const cashContext = eligible.filter(({ reading }) => reading.signal === "cash");
  const supportedLongs = eligible.filter(({ reading }) => reading.relationship === "supports_user_long").map(({ trade }) => trade);
  const unsupportedLongs = eligible.filter(({ reading }) => reading.relationship === "does_not_support_user_long").map(({ trade }) => trade);
  const group = (selected: typeof supportedLongs) => ({
    trades: selected.length,
    wins: selected.filter((trade) => trade.outcome === "win").length,
    winRatePct: selected.length ? round(selected.filter((trade) => trade.outcome === "win").length / selected.length * 100, 2) : null,
    netPnlUsd: round(selected.reduce((sum, trade) => sum + trade.pnlUsd, 0), 8),
  });
  const moveUp = longContext.filter(({ trade }) => trade.marketMovePct > 0).length;
  const moveDown = longContext.filter(({ trade }) => trade.marketMovePct < 0).length;
  const directional = moveUp + moveDown;
  return {
    key, name,
    eligibleTrades: eligible.length,
    insufficientHistory: readings.length - eligible.length,
    longContextTrades: longContext.length,
    cashContextTrades: cashContext.length,
    longContextMoveUp: moveUp,
    longContextMoveDown: moveDown,
    longContextDirectionalAccuracyPct: directional ? round(moveUp / directional * 100, 2) : null,
    supportedUserLongs: group(supportedLongs),
    unsupportedUserLongs: group(unsupportedLongs),
    userShortContext: {
      longSignalConflicts: eligible.filter(({ reading }) => reading.relationship === "conflicts_with_user_short").length,
      cashMeansNoShortOpinion: eligible.filter(({ reading }) => reading.relationship === "no_short_opinion").length,
    },
  };
}

function relationship(side: "LONG" | "SHORT", signal: BinarySignal): EngineRelationship {
  if (side === "LONG") return signal ? "supports_user_long" : "does_not_support_user_long";
  return signal ? "conflicts_with_user_short" : "no_short_opinion";
}

function validateTrade(trade: ClosedTradeInput, index: number): void {
  if (!trade || typeof trade !== "object") throw inputError(`trades[${index}] must be an object.`);
  if (trade.side !== "LONG" && trade.side !== "SHORT") throw inputError(`trades[${index}] side must be LONG or SHORT.`);
  if (!normalizeSymbol(trade.symbol)) throw inputError(`trades[${index}] symbol is required.`);
  if (!Number.isFinite(Date.parse(trade.entryTimestamp)) || !Number.isFinite(Date.parse(trade.exitTimestamp))) throw inputError(`trades[${index}] timestamps are invalid.`);
  if (Date.parse(trade.exitTimestamp) < Date.parse(trade.entryTimestamp)) throw inputError(`trades[${index}] exits before it enters.`);
  for (const [field, value] of [["entryPrice", trade.entryPrice], ["exitPrice", trade.exitPrice]] as const) {
    if (!Number.isFinite(value) || value <= 0) throw inputError(`trades[${index}] ${field} must be positive.`);
  }
  if (!Number.isFinite(trade.pnlUsd)) throw inputError(`trades[${index}] pnlUsd must be finite.`);
}

function normalizeSymbol(value: unknown): string {
  return String(value || "").trim().toUpperCase().replace("/", "-").replace(/_USD$/, "-USD");
}

function required(value: unknown, field: string, line: number): string {
  const result = String(value || "").trim();
  if (!result) throw inputError(`JSONL line ${line} is missing ${field}.`);
  return result;
}

function timestamp(value: unknown, field: string, line: number): string {
  const result = required(value, field, line);
  if (Number.isNaN(Date.parse(result))) throw inputError(`JSONL line ${line} has an invalid ${field}.`);
  return result;
}

function finite(value: unknown, field: string, line: number): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(result)) throw inputError(`JSONL line ${line} has invalid ${field}.`);
  return result;
}

function positive(value: unknown, field: string, line: number): number {
  const result = finite(value, field, line);
  if (result <= 0) throw inputError(`JSONL line ${line} has invalid ${field}.`);
  return result;
}

function outcome(pnlUsd: number): "win" | "loss" | "flat" { return pnlUsd > 0 ? "win" : pnlUsd < 0 ? "loss" : "flat"; }
function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2, 3);
}
function round(value: number, places: number): number { return Number(value.toFixed(places)); }
function inputError(message: string): Error & { statusCode: number } { return Object.assign(new Error(message), { statusCode: 400 }); }
