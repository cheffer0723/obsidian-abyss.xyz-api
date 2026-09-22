import { Router } from "express";
import { z } from "zod";
import {
  claimLoginIntent,
  currentUser,
  databaseReady,
  entitlementFor,
  isAdminEmail,
  requestMagicLink,
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
