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

export async function requestMagicLink(emailInput: string, returnTo = "/"): Promise<void> {
  await ensureSchema();
  const email = normalizeEmail(emailInput);
  const user = await pool!.query<{ id: string }>(`INSERT INTO abyss_users (id,email) VALUES ($1,$2) ON CONFLICT (email) DO UPDATE SET email=EXCLUDED.email RETURNING id`, [crypto.randomUUID(), email]);
  const token = randomToken();
  await pool!.query(`INSERT INTO abyss_auth_tokens (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '20 minutes')`, [hash(token), user.rows[0].id]);
  const apiUrl = (process.env.AUTH_API_URL || "https://webapp-backend-production-7f0f.up.railway.app/api").replace(/\/$/, "");
  const link = `${apiUrl}/auth/verify?token=${encodeURIComponent(token)}&returnTo=${encodeURIComponent(returnTo)}`;
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    logger.warn({ emailDomain: email.split("@")[1] }, "Magic link not sent: SMTP is not configured");
    return;
  }
  const transporter = nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === "true", auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } });
  try {
    await transporter.sendMail({ from: process.env.MAIL_FROM || process.env.SMTP_USER, to: email, subject: "Your Obsidian Abyss sign-in link", text: `Enter the Abyss: ${link}\n\nThis link expires in 20 minutes and can be used once.` });
  } catch (error) {
    logger.warn({ emailDomain: email.split("@")[1], error: error instanceof Error ? error.name : "unknown" }, "Magic link delivery failed");
  }
}

export async function verifyMagicLink(token: string, res: Response): Promise<boolean> {
  await ensureSchema();
  const session = randomToken();
  const result = await pool!.query<{ user_id: string }>(`UPDATE abyss_auth_tokens SET used_at=now() WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() RETURNING user_id`, [hash(token)]);
  if (!result.rowCount) return false;
  await pool!.query(`INSERT INTO abyss_sessions (token_hash,user_id,expires_at) VALUES ($1,$2,now()+interval '30 days')`, [hash(session), result.rows[0].user_id]);
  // The Pages frontend and Railway API are different sites; Secure + None is
  // required for the browser to send this HttpOnly session cookie cross-site.
  res.cookie("abyss_session", session, { httpOnly: true, secure: true, sameSite: "none", maxAge: 30 * 24 * 60 * 60 * 1000 });
  return true;
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
