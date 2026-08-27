import { Router } from "express";
import { z } from "zod";
import { currentUser, entitlementFor, requestMagicLink, verifyMagicLink, databaseReady } from "../lib/account.js";

const router = Router();
const emailSchema = z.object({ email: z.string().trim().email().max(320) });

router.post("/auth/request-link", async (req, res, next) => { try { if (!databaseReady()) return res.status(503).json({ ok: false, error: "Authentication is temporarily unavailable." }); const { email } = emailSchema.parse(req.body); await requestMagicLink(email); res.json({ ok: true, message: "If that address is eligible, a sign-in link is on its way." }); } catch (e) { next(e); } });
router.get("/auth/verify", async (req, res, next) => { try { const token = z.string().min(20).parse(req.query.token); const ok = await verifyMagicLink(token, res); const appUrl = (process.env.AUTH_APP_URL || "https://obsidian-abyss.xyz").replace(/\/$/, ""); res.redirect(`${appUrl}/?auth=${ok ? "success" : "invalid"}`); } catch (e) { next(e); } });
router.get("/auth/me", async (req, res, next) => { try { const user = await currentUser(req); if (!user) return res.status(401).json({ ok: false, authenticated: false }); res.json({ ok: true, authenticated: true, user: { email: user.email }, entitlement: await entitlementFor(user.id) }); } catch (e) { next(e); } });
export default router;
