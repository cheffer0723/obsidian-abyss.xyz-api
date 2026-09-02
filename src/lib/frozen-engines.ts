export type FrozenEngineKey = "orthrus" | "hydra" | "sisyphus";
export type MarketKind = "eq" | "btc";
export type BinarySignal = 0 | 1;

export interface HistoricalClose {
  date: string;
  close: number;
}

export interface FrozenEngineDefinition {
  key: FrozenEngineKey;
  name: "Orthrus" | "Hydra" | "Sisyphus";
  type: string;
  warmupBars: (kind: MarketKind) => number;
  rule: string;
}

export interface FrozenEngineEvaluation {
  ok: true;
  purpose: "historical_testing_only";
  executionCapable: false;
  source: typeof FROZEN_ENGINE_SOURCE;
  marketKind: MarketKind;
  bars: number;
  timing: {
    signalAvailability: "after_each_daily_close";
    recoveredSourceConvention: string;
    harnessReplayConvention: string;
  };
  engines: Array<{
    key: FrozenEngineKey;
    name: string;
    type: string;
    warmupBars: number;
    rule: string;
    activeSignalBars: number;
    signalAtClose: Array<{ date: string; signal: BinarySignal }>;
  }>;
}

export const FROZEN_ENGINE_SOURCE = {
  file: "scripts/build_engines.py",
  sha256: "8BF30D9A76E01C0E0FF7757D249868CFB69043BBA14870B11EA1CB0E237D62B0",
  recoveredEndDate: "2026-06-23",
  version: "recovered-2026-06-23-v1",
} as const;

const MOMENTUM_LOOKBACK: Record<MarketKind, number> = { eq: 126, btc: 182 };

export const FROZEN_ENGINES: readonly FrozenEngineDefinition[] = [
  {
    key: "orthrus",
    name: "Orthrus",
    type: "Trend-following",
    warmupBars: () => 200,
    rule: "Signal 1 when the daily close is above its 200-bar simple moving average; otherwise 0.",
  },
  {
    key: "hydra",
    name: "Hydra",
    type: "Momentum",
    warmupBars: (kind) => MOMENTUM_LOOKBACK[kind],
    rule: "Signal 1 when the trailing six-month close-to-close return is positive; otherwise 0 (126 equity bars, 182 Bitcoin bars).",
  },
  {
    key: "sisyphus",
    name: "Sisyphus",
    type: "Mean-reversion",
    warmupBars: () => 20,
    rule: "Signal 1 when the daily close is below the 20-bar mean minus two sample standard deviations; otherwise 0.",
  },
] as const;

export function calculateFrozenEngineSignals(closes: readonly number[], kind: MarketKind): Record<FrozenEngineKey, BinarySignal[]> {
  validateCloses(closes);
  if (kind !== "eq" && kind !== "btc") throw inputError("marketKind must be eq or btc.");
  return {
    orthrus: orthrusSignals(closes),
    hydra: hydraSignals(closes, MOMENTUM_LOOKBACK[kind]),
    sisyphus: sisyphusSignals(closes),
  };
}

export function evaluateFrozenEngines(bars: readonly HistoricalClose[], kind: MarketKind): FrozenEngineEvaluation {
  if (!Array.isArray(bars) || bars.length === 0) throw inputError("bars must contain at least one historical daily close.");
  const seenDates = new Set<string>();
  let previousTime = Number.NEGATIVE_INFINITY;
  for (const [index, bar] of bars.entries()) {
    if (!bar || typeof bar !== "object") throw inputError(`bars[${index}] must be an object.`);
    const date = String(bar.date || "");
    const time = Date.parse(date);
    if (!date || Number.isNaN(time)) throw inputError(`bars[${index}] has an invalid date.`);
    if (seenDates.has(date)) throw inputError(`bars contains duplicate date ${date}.`);
    if (time <= previousTime) throw inputError("bars must be sorted in strictly increasing date order.");
    seenDates.add(date);
    previousTime = time;
  }
  const signals = calculateFrozenEngineSignals(bars.map((bar) => bar.close), kind);
  return {
    ok: true,
    purpose: "historical_testing_only",
    executionCapable: false,
    source: FROZEN_ENGINE_SOURCE,
    marketKind: kind,
    bars: bars.length,
    timing: {
      signalAvailability: "after_each_daily_close",
      recoveredSourceConvention: "The recovered backtest applies signal[t-1] to the close-to-close return ending at t, despite editorial wording that says acts at the next close.",
      harnessReplayConvention: "A trade may only use a signal from a daily close strictly earlier than the trade timestamp.",
    },
    engines: FROZEN_ENGINES.map((engine) => ({
      key: engine.key,
      name: engine.name,
      type: engine.type,
      warmupBars: engine.warmupBars(kind),
      rule: engine.rule,
      activeSignalBars: signals[engine.key].reduce<number>((sum, signal) => sum + signal, 0),
      signalAtClose: bars.map((bar, index) => ({ date: bar.date, signal: signals[engine.key][index] })),
    })),
  };
}

function orthrusSignals(closes: readonly number[]): BinarySignal[] {
  return closes.map((close, index) => {
    if (index < 199) return 0;
    const mean = average(closes, index - 199, index);
    return close > mean ? 1 : 0;
  });
}

function hydraSignals(closes: readonly number[], lookback: number): BinarySignal[] {
  return closes.map((close, index) => index >= lookback && close / closes[index - lookback] - 1 > 0 ? 1 : 0);
}

function sisyphusSignals(closes: readonly number[]): BinarySignal[] {
  return closes.map((close, index) => {
    if (index < 19) return 0;
    const start = index - 19;
    const mean = average(closes, start, index);
    let squaredDifference = 0;
    for (let i = start; i <= index; i += 1) squaredDifference += (closes[i] - mean) ** 2;
    const sampleStandardDeviation = Math.sqrt(squaredDifference / 19);
    return close < mean - 2 * sampleStandardDeviation ? 1 : 0;
  });
}

function average(values: readonly number[], start: number, end: number): number {
  let total = 0;
  for (let i = start; i <= end; i += 1) total += values[i];
  return total / (end - start + 1);
}

function validateCloses(closes: readonly number[]): void {
  if (!Array.isArray(closes) || closes.length === 0) throw inputError("closes must contain at least one value.");
  for (const [index, close] of closes.entries()) {
    if (!Number.isFinite(close) || close <= 0) throw inputError(`closes[${index}] must be a positive finite number.`);
  }
}

function inputError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}
