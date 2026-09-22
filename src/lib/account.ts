import crypto from "node:crypto";
import { Pool } from "pg";
import nodemailer from "nodemailer";
import type { Request, Response } from "express";
import { logger } from "./logger.js";

const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined }) : null;
let schemaReady: Promise<void> | null = null;

export function databaseReady(): boolean { return Boolean(pool); }

async function ensureSchema(): Promise<void> {
  if (!pool) throw new Error("Database is not configured.");
  if (!schemaReady) schemaReady = pool.query(`
    CREATE TABLE IF NOT EXISTS abyss_users (id uuid PRIMARY KEY, email text UNIQUE NOT NULL, stripe_customer_id text UNIQUE, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS abyss_auth_tokens (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES abyss_users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL, used_at timestamptz);
    CREATE TABLE IF NOT EXISTS abyss_sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES abyss_users(id) ON DELETE CASCADE, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS abyss_entitlements (user_id uuid PRIMARY KEY REFERENCES abyss_users(id) ON DELETE CASCADE, stripe_subscription_id text UNIQUE NOT NULL, status text NOT NULL, current_period_end timestamptz, updated_at timestamptz NOT NULL DEFAULT now());
    CREATE TABLE IF NOT EXISTS abyss_metric_events (
      id bigserial PRIMARY KEY,
      occurred_at timestamptz NOT NULL DEFAULT now(),
      event_type text NOT NULL,
      outcome text NOT NULL,
      duration_ms integer,
      trade_count integer,
      matched_trade_count integer,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb
    );
    CREATE TABLE IF NOT EXISTS abyss_beta_feedback (
      id uuid PRIMARY KEY,
      created_at timestamptz NOT NULL DEFAULT now(),
      category text NOT NULL,
      message text NOT NULL,
      contact_email text,
      page_path text,
      user_agent text,
      user_id uuid REFERENCES abyss_users(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS abyss_login_intents (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES abyss_users(id) ON DELETE CASCADE,
      token_hash text NOT NULL REFERENCES abyss_auth_tokens(token_hash) ON DELETE CASCADE,
      return_to text NOT NULL DEFAULT '/',
      status text NOT NULL DEFAULT 'pending',
      claim_code_hash text,
      created_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      approved_at timestamptz,
      claimed_at timestamptz
    );
    CREATE INDEX IF NOT EXISTS abyss_metric_events_occurred_at_idx ON abyss_metric_events (occurred_at DESC);
    CREATE INDEX IF NOT EXISTS abyss_metric_events_type_outcome_idx ON abyss_metric_events (event_type, outcome, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS abyss_beta_feedback_created_at_idx ON abyss_beta_feedback (created_at DESC);
    CREATE INDEX IF NOT EXISTS abyss_beta_feedback_category_idx ON abyss_beta_feedback (category, created_at DESC);
    CREATE INDEX IF NOT EXISTS abyss_login_intents_status_idx ON abyss_login_intents (status, expires_at);
  `).then(() => undefined);
  await schemaReady;
}

function hash(value: string): string { return crypto.createHash("sha256").update(value).digest("hex"); }
function randomToken(): string { return crypto.randomBytes(32).toString("base64url"); }
function normalizeEmail(email: string): string { return email.trim().toLowerCase(); }

export function isAdminEmail(email: string): boolean {
  const normalized = normalizeEmail(email);
  return (process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean)
    .includes(normalized);
}

function setSessionCookie(res: Response, session: string): void {
  // Pages frontend and Railway API are different sites; Secure + None is required
  // for credentialed cross-site fetches after verify/claim.
  res.cookie("abyss_session", session, { httpOnly: true, secure: true, sameSite: "none", maxAge: 30 * 24 * 60 * 60 * 1000 });
}

async function createSession(userId: string, res: Response): Promise<void> {
  const session = randomToken();
  await pool!.query(`INSERT INTO abyss_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '30 days')`, [hash(session), userId]);
  setSessionCookie(res, session);
}

export async function requestMagicLink(
  emailInput: string,
  returnTo = "/",
): Promise<{ loginIntentId: string; waiterSecret: string }> {
  await ensureSchema();
  const email = normalizeEmail(emailInput);
  const user = await pool!.query<{ id: string }>(`INSERT INTO abyss_users (id,email) VALUES ($1,$2) ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`, [crypto.randomUUID(), email]);
  const token = randomToken();
  const tokenHash = hash(token);
  const loginIntentId = crypto.randomUUID();
  const waiterSecret = randomToken();
  await pool!.query(`INSERT INTO abyss_auth_tokens (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '20 minutes')`, [tokenHash, user.rows[0].id]);
  await pool!.query(
    `INSERT INTO abyss_login_intents (id, user_id, token_hash, return_to, status, claim_code_hash, expires_at)
     VALUES ($1,$2,$3,$4,'pending',$5,now()+interval '20 minutes')`,
    [loginIntentId, user.rows[0].id, tokenHash, returnTo, hash(waiterSecret)],
  );
  void recordMetricEvent({ eventType: "magic_link_requested", outcome: "accepted" });
  const apiUrl = (process.env.AUTH_API_URL || "https://webapp-backend-production-7f0f.up.railway.app/api").replace(/\/$/, "");
  const link = `${apiUrl}/auth/verify?token=${encodeURIComponent(token)}&returnTo=${encodeURIComponent(returnTo)}`;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    logger.warn({ emailDomain: email.split("@")[1] }, "Magic link not sent: SMTP is not configured");
    return { loginIntentId, waiterSecret };
  }
  const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === "true", auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  try {
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: email,
      subject: "Your Obsidian Abyss sign-in link",
      text: [
        `Enter the Abyss: ${link}`,
        "",
        "Open this link on any device. The computer that requested sign-in will finish automatically.",
        "This link expires in 20 minutes and can be used once.",
      ].join("\n"),
    });
  } catch (error) {
    logger.warn({ emailDomain: email.split("@")[1], error: error instanceof Error ? error.name : "unknown" }, "Magic link delivery failed");
  }
  return { loginIntentId, waiterSecret };
}

export async function verifyMagicLink(token: string, res: Response): Promise<boolean> {
  await ensureSchema();
  const result = await pool!.query<{ user_id: string }>(`UPDATE abyss_auth_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id`, [hash(token)]);
  if (!result.rowCount) return false;
  await createSession(result.rows[0].user_id, res);
  void recordMetricEvent({ eventType: "magic_link_verified", outcome: "success" });
  await pool!.query(
    `UPDATE abyss_login_intents
     SET status='approved', approved_at=now()
     WHERE token_hash=$1 AND status='pending' AND expires_at>now()`,
    [hash(token)],
  );
  return true;
}

export type LoginClaimResult =
  | { status: "pending"; returnTo: string }
  | { status: "claimed"; returnTo: string }
  | { status: "expired"; returnTo: string }
  | { status: "invalid" };

export async function claimLoginIntent(intentId: string, waiterSecret: string, res: Response): Promise<LoginClaimResult> {
  await ensureSchema();
  const result = await pool!.query<{
    user_id: string;
    return_to: string;
    status: string;
    claim_code_hash: string | null;
    expires_at: Date;
  }>(
    `SELECT user_id, return_to, status, claim_code_hash, expires_at
     FROM abyss_login_intents WHERE id=$1`,
    [intentId],
  );
  const row = result.rows[0];
  if (!row || !row.claim_code_hash || row.claim_code_hash !== hash(waiterSecret)) {
    return { status: "invalid" };
  }
  if (row.expires_at.getTime() <= Date.now()) {
    if (row.status === "pending" || row.status === "approved") {
      await pool!.query(`UPDATE abyss_login_intents SET status='expired' WHERE id=$1 AND status IN ('pending','approved')`, [intentId]);
    }
    return { status: "expired", returnTo: row.return_to };
  }
  if (row.status === "pending") return { status: "pending", returnTo: row.return_to };
  if (row.status === "claimed") return { status: "claimed", returnTo: row.return_to };
  if (row.status === "expired") return { status: "expired", returnTo: row.return_to };
  if (row.status !== "approved") return { status: "invalid" };

  const updated = await pool!.query<{ user_id: string; return_to: string }>(
    `UPDATE abyss_login_intents
     SET status='claimed', claimed_at=now()
     WHERE id=$1 AND status='approved' AND claim_code_hash=$2
     RETURNING user_id, return_to`,
    [intentId, hash(waiterSecret)],
  );
  if (!updated.rowCount) return { status: "pending", returnTo: row.return_to };
  await createSession(updated.rows[0].user_id, res);
  return { status: "claimed", returnTo: updated.rows[0].return_to };
}

export async function currentUser(req: Request): Promise<{ id: string; email: string } | null> {
  await ensureSchema();
  const token = req.header("x-abyss-session") || req.cookies?.abyss_session;
  if (!token) return null;
  const result = await pool!.query<{ id: string; email: string }>(`SELECT u.id,u.email FROM abyss_sessions s JOIN abyss_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()`, [hash(token)]);
  return result.rows[0] || null;
}

export async function upsertEntitlement(stripeCustomerId: string, subscriptionId: string, status: string, periodEnd: number | null): Promise<void> {
  await ensureSchema();
  const user = await pool!.query<{ id: string }>(`SELECT id FROM abyss_users WHERE stripe_customer_id=$1`, [stripeCustomerId]);
  if (!user.rowCount) return;
  await pool!.query(`INSERT INTO abyss_entitlements (user_id,stripe_subscription_id,status,current_period_end) VALUES ($1,$2,$3,$4) ON CONFLICT (user_id) DO UPDATE SET stripe_subscription_id=EXCLUDED.stripe_subscription_id,status=EXCLUDED.status,current_period_end=EXCLUDED.current_period_end,updated_at=now()`, [user.rows[0].id, subscriptionId, status, periodEnd ? new Date(periodEnd * 1000) : null]);
}

export async function bindStripeCustomer(userId: string, customerId: string): Promise<void> { await ensureSchema(); await pool!.query(`UPDATE abyss_users SET stripe_customer_id=$1 WHERE id=$2`, [customerId, userId]); }
export async function entitlementFor(userId: string): Promise<{ active: boolean; status: string | null }> { await ensureSchema(); const r = await pool!.query<{ status: string }>(`SELECT status FROM abyss_entitlements WHERE user_id=$1`, [userId]); return { active: ["active", "trialing", "past_due"].includes(r.rows[0]?.status || ""), status: r.rows[0]?.status || null }; }

export type MetricEvent = {
  eventType: "magic_link_requested" | "magic_link_verified" | "checkout_created" | "billing_webhook" | "harness_replay";
  outcome: "accepted" | "success" | "failed" | "rejected";
  durationMs?: number;
  tradeCount?: number;
  matchedTradeCount?: number;
  metadata?: Record<string, unknown>;
};

/**
 * Product telemetry is deliberately aggregate-only. Do not place email addresses,
 * user ids, CSV text, trade rows, payment ids, or secrets in metadata.
 */
export async function recordMetricEvent(event: MetricEvent): Promise<void> {
  if (!pool) return;
  try {
    await ensureSchema();
    await pool.query(
      `INSERT INTO abyss_metric_events (event_type,outcome,duration_ms,trade_count,matched_trade_count,metadata)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
      [
        event.eventType,
        event.outcome,
        finitePositiveInteger(event.durationMs),
        finitePositiveInteger(event.tradeCount),
        finitePositiveInteger(event.matchedTradeCount),
        JSON.stringify(event.metadata || {}),
      ],
    );
  } catch (error) {
    logger.warn({ metricEvent: event.eventType, metricError: error instanceof Error ? error.name : "unknown" }, "Metric event was not stored");
  }
}

export type AdminMetricEvent = {
  eventType: string;
  outcome: string;
  occurredAt: string;
  durationMs: number | null;
  tradeCount: number | null;
  matchedTradeCount: number | null;
};

export type AdminOverview = {
  generatedAt: string;
  windowDays: number;
  accounts: { total: number; createdInWindow: number; activeAccess: number };
  access: { linksRequested: number; linksVerified: number };
  billing: { checkoutCreated: number; webhookProcessed: number; webhookFailed: number };
  harness: {
    replayCompleted: number;
    replayFailed: number;
    acceptedRatePct: number | null;
    dataCoveragePct: number | null;
    medianReplayMs: number | null;
    tradesTested: number;
    matchedTrades: number;
  };
  engines: Array<{ key: string; eligibleTrades: number; longContextTrades: number }>;
  events: AdminMetricEvent[];
};

export async function getAdminOverview(windowDays: 7 | 30): Promise<AdminOverview> {
  await ensureSchema();
  const [accounts, eventRows, engines, events] = await Promise.all([
    pool!.query<{ total: string; created_in_window: string; active_access: string }>(
      `SELECT
        count(*)::text AS total,
        count(*) FILTER (WHERE created_at >= now() - ($1 * interval '1 day'))::text AS created_in_window,
        (SELECT count(*) FROM abyss_entitlements WHERE status IN ('active','trialing','past_due'))::text AS active_access
       FROM abyss_users`,
      [windowDays],
    ),
    pool!.query<{ event_type: string; outcome: string; count: string; trades: string; matched: string; median_ms: number | null }>(
      `SELECT event_type, outcome, count(*)::text AS count,
        coalesce(sum(trade_count), 0)::text AS trades,
        coalesce(sum(matched_trade_count), 0)::text AS matched,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) FILTER (WHERE duration_ms IS NOT NULL) AS median_ms
       FROM abyss_metric_events
       WHERE occurred_at >= now() - ($1 * interval '1 day')
       GROUP BY event_type, outcome`,
      [windowDays],
    ),
    pool!.query<{ key: string; eligible_trades: string; long_context_trades: string }>(
      `SELECT sample->>'key' AS key,
        coalesce(sum((sample->>'eligibleTrades')::integer), 0)::text AS eligible_trades,
        coalesce(sum((sample->>'longContextTrades')::integer), 0)::text AS long_context_trades
       FROM abyss_metric_events
       CROSS JOIN LATERAL jsonb_array_elements(coalesce(metadata->'engineSamples', '[]'::jsonb)) AS sample
       WHERE event_type = 'harness_replay' AND outcome = 'success'
         AND occurred_at >= now() - ($1 * interval '1 day')
       GROUP BY sample->>'key'
       ORDER BY sample->>'key'`,
      [windowDays],
    ),
    pool!.query<{ event_type: string; outcome: string; occurred_at: Date; duration_ms: number | null; trade_count: number | null; matched_trade_count: number | null }>(
      `SELECT event_type, outcome, occurred_at, duration_ms, trade_count, matched_trade_count
       FROM abyss_metric_events
       WHERE occurred_at >= now() - ($1 * interval '1 day')
       ORDER BY occurred_at DESC
       LIMIT 40`,
      [windowDays],
    ),
  ]);
  const count = (eventType: string, outcome?: string) => eventRows.rows
    .filter((row) => row.event_type === eventType && (!outcome || row.outcome === outcome))
    .reduce((sum, row) => sum + Number(row.count), 0);
  const replayRows = eventRows.rows.filter((row) => row.event_type === "harness_replay");
  const replaySuccess = replayRows.filter((row) => row.outcome === "success");
  const replayCompleted = replaySuccess.reduce((sum, row) => sum + Number(row.count), 0);
  const replayFailed = replayRows.filter((row) => row.outcome !== "success").reduce((sum, row) => sum + Number(row.count), 0);
  const tradesTested = replaySuccess.reduce((sum, row) => sum + Number(row.trades), 0);
  const matchedTrades = replaySuccess.reduce((sum, row) => sum + Number(row.matched), 0);
  const medianValues = replaySuccess.map((row) => row.median_ms).filter((value): value is number => typeof value === "number");
  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    accounts: {
      total: Number(accounts.rows[0]?.total || 0),
      createdInWindow: Number(accounts.rows[0]?.created_in_window || 0),
      activeAccess: Number(accounts.rows[0]?.active_access || 0),
    },
    access: { linksRequested: count("magic_link_requested", "accepted"), linksVerified: count("magic_link_verified", "success") },
    billing: { checkoutCreated: count("checkout_created", "success"), webhookProcessed: count("billing_webhook", "success"), webhookFailed: count("billing_webhook", "failed") },
    harness: {
      replayCompleted,
      replayFailed,
      acceptedRatePct: replayCompleted + replayFailed ? round(replayCompleted / (replayCompleted + replayFailed) * 100, 1) : null,
      dataCoveragePct: tradesTested ? round(matchedTrades / tradesTested * 100, 1) : null,
      medianReplayMs: medianValues.length ? Math.round(medianValues.reduce((sum, value) => sum + value, 0) / medianValues.length) : null,
      tradesTested,
      matchedTrades,
    },
    engines: engines.rows.map((row) => ({ key: row.key, eligibleTrades: Number(row.eligible_trades), longContextTrades: Number(row.long_context_trades) })),
    events: events.rows.map((row) => ({
      eventType: row.event_type,
      outcome: row.outcome,
      occurredAt: row.occurred_at.toISOString(),
      durationMs: row.duration_ms,
      tradeCount: row.trade_count,
      matchedTradeCount: row.matched_trade_count,
    })),
  };
}

function finitePositiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

function round(value: number, places: number): number { return Number(value.toFixed(places)); }

export type BetaFeedbackCategory = "comment" | "concern" | "bug" | "idea";

export type BetaFeedbackInput = {
  category: BetaFeedbackCategory;
  message: string;
  contactEmail?: string | null;
  pagePath?: string | null;
  userAgent?: string | null;
  userId?: string | null;
};

export type BetaFeedbackRow = {
  id: string;
  createdAt: string;
  category: BetaFeedbackCategory;
  message: string;
  contactEmail: string | null;
  pagePath: string | null;
};

export async function submitBetaFeedback(input: BetaFeedbackInput): Promise<{ id: string }> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const message = input.message.trim();
  if (message.length < 8 || message.length > 4000) {
    throw new Error("Feedback must be between 8 and 4000 characters.");
  }
  const contactEmail = input.contactEmail ? normalizeEmail(input.contactEmail) : null;
  if (contactEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
    throw new Error("That contact email does not look valid.");
  }
  await pool!.query(
    `INSERT INTO abyss_beta_feedback (id, category, message, contact_email, page_path, user_agent, user_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      id,
      input.category,
      message,
      contactEmail,
      (input.pagePath || "").trim().slice(0, 200) || null,
      (input.userAgent || "").trim().slice(0, 400) || null,
      input.userId || null,
    ],
  );
  void notifyFeedbackSubmitted({ id, category: input.category, message, contactEmail });
  return { id };
}

export async function listBetaFeedback(limit = 50): Promise<BetaFeedbackRow[]> {
  await ensureSchema();
  const capped = Math.min(Math.max(limit, 1), 100);
  const rows = await pool!.query<{
    id: string;
    created_at: Date;
    category: BetaFeedbackCategory;
    message: string;
    contact_email: string | null;
    page_path: string | null;
  }>(
    `SELECT id, created_at, category, message, contact_email, page_path
     FROM abyss_beta_feedback
     ORDER BY created_at DESC
     LIMIT $1`,
    [capped],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at.toISOString(),
    category: row.category,
    message: row.message,
    contactEmail: row.contact_email,
    pagePath: row.page_path,
  }));
}

async function notifyFeedbackSubmitted(input: {
  id: string;
  category: string;
  message: string;
  contactEmail: string | null;
}): Promise<void> {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return;
  const recipients = (process.env.FEEDBACK_NOTIFY_EMAILS || process.env.ADMIN_EMAILS || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
  if (!recipients.length) return;
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to: recipients.join(","),
      subject: `[Obsidian Abyss beta] ${input.category}: feedback received`,
      text: [
        `Category: ${input.category}`,
        `Contact: ${input.contactEmail || "(not provided)"}`,
        `Id: ${input.id}`,
        "",
        input.message,
      ].join("\n"),
    });
  } catch (error) {
    logger.warn({ feedbackId: input.id, error: error instanceof Error ? error.name : "unknown" }, "Feedback notify email failed");
  }
}
