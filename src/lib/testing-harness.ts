export type ImportWarning = { code: string; message: string; count?: number };

export interface KrakenExecution {
  transactionId: string;
  orderId: string;
  pair: string;
  timestamp: string;
  side: "buy" | "sell";
  orderType: string;
  price: number;
  cost: number;
  fee: number;
  volume: number;
  margin: number;
}

export interface KrakenImportResult {
  ok: true;
  kind: "kraken_trades";
  purpose: "historical_testing_only";
  executionCapable: false;
  rows: number;
  uniqueTransactions: number;
  uniqueOrders: number;
  pairs: string[];
  dateRange: { first: string; last: string };
  totals: { cost: number; fees: number; volumeByPair: Record<string, number> };
  warnings: ImportWarning[];
  preview: Array<Omit<KrakenExecution, "transactionId" | "orderId">>;
}

export interface PaperAccountingReport {
  ok: true;
  kind: "onyx_closed_paper_positions";
  purpose: "historical_testing_only";
  executionCapable: false;
  rows: number;
  verifiedAccounting: number;
  mismatchedAccounting: number;
  missingAccountingFields: number;
  invalidRows: number;
  symbols: string[];
  dateRange: { first: string | null; last: string | null };
}

const KRAKEN_REQUIRED = ["txid", "ordertxid", "pair", "time", "type", "ordertype", "price", "cost", "fee", "vol", "margin"];

export function importHistoricalCsv(csvText: string): KrakenImportResult {
  const rows = parseCsv(csvText);
  if (rows.length < 2) throw inputError("CSV must contain a header and at least one data row.");
  const headers = rows[0].map((v) => v.trim().toLowerCase());
  const index = new Map(headers.map((header, i) => [header, i]));
  const missing = KRAKEN_REQUIRED.filter((header) => !index.has(header));
  if (missing.length) {
    throw inputError(`Unsupported CSV. Kraken Trades fields missing: ${missing.join(", ")}.`);
  }

  const executions = rows.slice(1).map((cells, offset) => {
    const line = offset + 2;
    const value = (name: string) => String(cells[index.get(name)!] ?? "").trim();
    const side = value("type").toLowerCase();
    if (side !== "buy" && side !== "sell") throw inputError(`CSV line ${line} type must be buy or sell.`);
    const timestamp = value("time");
    if (!timestamp || Number.isNaN(Date.parse(timestamp.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(timestamp) ? "" : "Z")))) {
      throw inputError(`CSV line ${line} has an invalid time.`);
    }
    return {
      transactionId: required(value("txid"), "txid", line),
      orderId: required(value("ordertxid"), "ordertxid", line),
      pair: required(value("pair"), "pair", line).toUpperCase(),
      timestamp,
      side,
      orderType: required(value("ordertype"), "ordertype", line),
      price: nonnegative(value("price"), "price", line, true),
      cost: nonnegative(value("cost"), "cost", line),
      fee: nonnegative(value("fee"), "fee", line),
      volume: nonnegative(value("vol"), "vol", line, true),
      margin: nonnegative(value("margin") || "0", "margin", line),
    } satisfies KrakenExecution;
  });

  const txCounts = count(executions.map((row) => row.transactionId));
  const orderCounts = count(executions.map((row) => row.orderId));
  const duplicateTransactions = [...txCounts.values()].filter((n) => n > 1).reduce((sum, n) => sum + n - 1, 0);
  const multiFillOrders = [...orderCounts.values()].filter((n) => n > 1).length;
  const marginRows = executions.filter((row) => row.margin > 0).length;
  const dates = executions.map((row) => row.timestamp).sort();
  const volumeByPair: Record<string, number> = {};
  for (const row of executions) volumeByPair[row.pair] = round((volumeByPair[row.pair] || 0) + row.volume, 12);

  const warnings: ImportWarning[] = [
    { code: "executions_are_not_positions", message: "Trade executions do not by themselves prove completed positions; opening inventory, partial fills and margin direction must be reconciled." },
  ];
  if (multiFillOrders) warnings.push({ code: "partial_fills", count: multiFillOrders, message: "Orders with multiple execution rows must be grouped before position accounting." });
  if (marginRows) warnings.push({ code: "margin_activity", count: marginRows, message: "Margin executions require an explicit position model; sells cannot automatically be treated as long exits." });
  if (duplicateTransactions) warnings.push({ code: "duplicate_transactions", count: duplicateTransactions, message: "Duplicate transaction IDs were retained for audit but must not be double-counted." });

  return {
    ok: true,
    kind: "kraken_trades",
    purpose: "historical_testing_only",
    executionCapable: false,
    rows: executions.length,
    uniqueTransactions: txCounts.size,
    uniqueOrders: orderCounts.size,
    pairs: [...new Set(executions.map((row) => row.pair))].sort(),
    dateRange: { first: dates[0], last: dates.at(-1)! },
    totals: {
      cost: round(executions.reduce((sum, row) => sum + row.cost, 0), 8),
      fees: round(executions.reduce((sum, row) => sum + row.fee, 0), 8),
      volumeByPair,
    },
    warnings,
    preview: executions.slice(0, 5).map(({ transactionId: _transactionId, orderId: _orderId, ...row }) => row),
  };
}

export function validateClosedPaperTradesJsonl(jsonlText: string, toleranceUsd = 0.01): PaperAccountingReport {
  let rows = 0, verified = 0, mismatched = 0, missing = 0, invalid = 0;
  const symbols = new Set<string>(), timestamps: string[] = [];
  for (const line of String(jsonlText || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try { row = JSON.parse(line) as Record<string, unknown>; }
    catch { invalid += 1; continue; }
    if (!row || typeof row !== "object" || Array.isArray(row)) { invalid += 1; continue; }
    rows += 1;
    if (String(row.status || "").toUpperCase() !== "CLOSED") { invalid += 1; continue; }
    if (row.symbol) symbols.add(String(row.symbol));
    for (const key of ["entry_timestamp_utc", "exit_timestamp_utc"]) if (typeof row[key] === "string") timestamps.push(String(row[key]));
    const entry = finite(row.entry_price), exit = finite(row.exit_price), quantity = finite(row.quantity);
    const totalFees = finite(row.total_fees_usd), storedGross = finite(row.gross_pnl_usd), storedNet = finite(row.pnl_usd);
    const side = String(row.side || "").toUpperCase();
    if ([entry, exit, quantity, totalFees, storedGross, storedNet].some((v) => v === null) || !["LONG", "SHORT"].includes(side)) {
      missing += 1; continue;
    }
    const multiplier = side === "LONG" ? 1 : -1;
    const computedGross = (exit! - entry!) * quantity! * multiplier;
    const computedNet = computedGross - totalFees!;
    if (Math.abs(computedGross - storedGross!) <= toleranceUsd && Math.abs(computedNet - storedNet!) <= toleranceUsd) verified += 1;
    else mismatched += 1;
  }
  timestamps.sort();
  return {
    ok: true, kind: "onyx_closed_paper_positions", purpose: "historical_testing_only", executionCapable: false,
    rows, verifiedAccounting: verified, mismatchedAccounting: mismatched,
    missingAccountingFields: missing, invalidRows: invalid, symbols: [...symbols].sort(),
    dateRange: { first: timestamps[0] || null, last: timestamps.at(-1) || null },
  };
}

function parseCsv(text: string): string[][] {
  const input = String(text || "").replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i], next = input[i + 1];
    if (ch === '"' && quoted && next === '"') { cell += '"'; i += 1; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (ch === "," && !quoted) { row.push(cell); cell = ""; continue; }
    if ((ch === "\n" || ch === "\r") && !quoted) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(cell); if (row.some((v) => v.trim())) rows.push(row); row = []; cell = ""; continue;
    }
    cell += ch;
  }
  if (quoted) throw inputError("CSV contains an unterminated quoted field.");
  row.push(cell); if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

function required(value: string, name: string, line: number): string {
  if (!value) throw inputError(`CSV line ${line} has an empty ${name}.`);
  return value;
}

function nonnegative(value: string, name: string, line: number, positive = false): number {
  if (!/^(?:\d+\.?\d*|\.\d+)$/.test(value)) throw inputError(`CSV line ${line} has invalid ${name}.`);
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || (positive && parsed <= 0)) throw inputError(`CSV line ${line} has invalid ${name}.`);
  return parsed;
}

function count(values: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const value of values) result.set(value, (result.get(value) || 0) + 1);
  return result;
}

function round(value: number, places: number): number { return Number(value.toFixed(places)); }

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function inputError(message: string): Error & { statusCode?: number } {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 400;
  return error;
}
