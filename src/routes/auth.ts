import { Router } from "express";
import { z } from "zod";
import {
  claimLoginIntent,
  completeTwoFactorLogin,
  currentUser,
  databaseReady,
  entitlementFor,
  isAdminEmail,
  logout,
  requestMagicLink,
  testLoginConfigured,
  testPasswordLogin,
  verifyMagicLink,
} from "../lib/account.js";

const router = Router();
const returnToSchema = z.enum(["/", "/demo", "/pricing", "/admin"]);
const emailSchema = z.object({
  email: z.string().trim().email().max(320),
  returnTo: returnToSchema.optional().default("/"),
});
const claimSchema = z.object({
  loginIntentId: z.string().uuid(),
  waiterSecret: z.string().min(20).max(200),
});
const testLoginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
});
const twoFactorVerifySchema = z.object({
  pendingToken: z.string().min(20).max(200),
  code: z.string().trim().regex(/^\d{6}$/),
});

function appUrl(): string {
  return (process.env.AUTH_APP_URL || "https://obsidianabyss.com").replace(/\/$/, "");
}

function redirectWithAuth(res: { redirect: (url: string) => void }, auth: "success" | "invalid" | "approved") {
  // Confirmations always land on /login so phone and desktop both see a clear result.
  res.redirect(`${appUrl()}/login?auth=${auth}`);
}

router.post("/auth/request-link", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Authentication is temporarily unavailable." });
      return;
    }
    const { email, returnTo } = emailSchema.parse(req.body);
    const { loginIntentId, waiterSecret } = await requestMagicLink(email, returnTo);
    res.json({
      ok: true,
      loginIntentId,
      waiterSecret,
      message: "If that address is eligible, a sign-in link is on its way.",
    });
  } catch (e) {
    next(e);
  }
});

router.get("/auth/verify", async (req, res, next) => {
  try {
    const token = z.string().min(20).parse(req.query.token);
    // returnTo is accepted for backwards-compatible email links; the waiting
    // browser uses the return path stored on the login intent instead.
    returnToSchema.catch("/").parse(req.query.returnTo);
    const ok = await verifyMagicLink(token, res);
    // Always send the confirming browser to a clear landing page. The waiting
    // desktop claims its own session via /auth/claim — it does not need this cookie.
    redirectWithAuth(res, ok ? "approved" : "invalid");
  } catch {
    redirectWithAuth(res, "invalid");
  }
});

router.post("/auth/claim", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Authentication is temporarily unavailable." });
      return;
    }
    const { loginIntentId, waiterSecret } = claimSchema.parse(req.body);
    const result = await claimLoginIntent(loginIntentId, waiterSecret, res);
    if (result.status === "invalid") {
      res.status(404).json({ ok: false, status: "invalid", error: "That sign-in request was not found." });
      return;
    }
    res.json({ ok: true, ...result });
  } catch (e) {
    if (e instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Invalid sign-in claim." });
      return;
    }
    next(e);
  }
});

// Test-only password sign-in. See account.ts: off entirely unless TEST_LOGIN_EMAIL and
// TEST_LOGIN_PASSWORD_HASH are both set, and only ever signs in that one exact address.
router.post("/auth/test-login", async (req, res, next) => {
  try {
    if (!testLoginConfigured()) {
      res.status(404).json({ ok: false, error: "Not found." });
      return;
    }
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Authentication is temporarily unavailable." });
      return;
    }
    const { email, password } = testLoginSchema.parse(req.body);
    const sourceIp = req.header("x-forwarded-for")?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    const result = await testPasswordLogin(email, password, sourceIp, res);
    if (result === "ok") { res.json({ ok: true }); return; }
    if (result === "locked") { res.status(429).json({ ok: false, error: "Too many attempts. Try again later." }); return; }
    if (typeof result === "object" && result.needsTwoFactor) { res.json({ ok: true, needsTwoFactor: true, pendingToken: result.pendingToken }); return; }
    res.status(401).json({ ok: false, error: "Invalid email or password." });
  } catch (e) {
    if (e instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Invalid sign-in." });
      return;
    }
    next(e);
  }
});

// The second step of sign-in for any account with 2FA enabled: a valid pendingToken (from
// test-login, or from /auth/claim's "needs-2fa" status) plus a real 6-digit code creates the
// session. A wrong or already-used code is refused the same way either way (401), never
// distinguishing "wrong code" from "that code was already used" -- see otp-reuse's own proof
// rule for why that distinction must not leak.
router.post("/auth/2fa/verify", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Authentication is temporarily unavailable." });
      return;
    }
    const { pendingToken, code } = twoFactorVerifySchema.parse(req.body);
    const ok = await completeTwoFactorLogin(pendingToken, code, res);
    if (!ok) {
      res.status(401).json({ ok: false, error: "That code is invalid or has expired." });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    if (e instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Enter the 6-digit code." });
      return;
    }
    next(e);
  }
});

router.post("/auth/logout", async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    await logout(req, res);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

router.get("/auth/me", async (req, res, next) => {
  try {
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, authenticated: false });
      return;
    }
    const admin = isAdminEmail(user.email);
    const entitlement = admin ? { active: true, status: "admin" } : await entitlementFor(user.id);
    res.json({ ok: true, authenticated: true, user: { email: user.email }, admin, entitlement });
  } catch (e) {
    next(e);
  }
});

export default router;
