import { Router } from "express";
import { z } from "zod";
import { currentUser, entitlementFor, requestMagicLink, verifyMagicLink, databaseReady, isAdminEmail } from "../lib/account.js";

const router = Router();
const returnToSchema = z.enum(["/", "/demo", "/pricing"]);
const emailSchema = z.object({ email: z.string().trim().email().max(320), returnTo: returnToSchema.optional().default("/") });

router.post("/auth/request-link", async (req, res, next) => { try { if (!databaseReady()) return res.status(503).json({ ok: false, error: "Authentication is temporarily unavailable." }); const { email, returnTo } = emailSchema.parse(req.body); await requestMagicLink(email, returnTo); res.json({ ok: true, message: "If that address is eligible, a sign-in link is on its way." }); } catch (e) { next(e); } });
router.get("/auth/verify", async (req, res, next) => { try { const token = z.string().min(20).parse(req.query.token); const returnTo = returnToSchema.catch("/").parse(req.query.returnTo); const ok = await verifyMagicLink(token, res); const appUrl = (process.env.AUTH_APP_URL || "https://obsidianabyss.com").replace(/\/$/, ""); const separator = returnTo.includes("?") ? "&" : "?"; res.redirect(`${appUrl}${returnTo}${separator}auth=${ok ? "success" : "invalid"}`); } catch (e) { next(e); } });
router.get("/auth/me", async (req, res, next) => { try { const user = await currentUser(req); if (!user) return res.status(401).json({ ok: false, authenticated: false }); const admin = isAdminEmail(user.email); const entitlement = admin ? { active: true, status: "admin" } : await entitlementFor(user.id); res.json({ ok: true, authenticated: true, user: { email: user.email }, admin, entitlement }); } catch (e) { next(e); } });
export default router;
