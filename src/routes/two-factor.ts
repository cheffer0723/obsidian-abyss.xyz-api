import { Router } from "express";
import { z } from "zod";
import { beginTwoFactorEnrollment, confirmTwoFactorEnrollment, currentUser, databaseReady, disableTwoFactor, isTwoFactorEnabled, verifyCurrentTwoFactorCode } from "../lib/account.js";

const router = Router();
const codeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/) });

router.get("/account/2fa", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "This is temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    res.json({ ok: true, enabled: await isTwoFactorEnabled(user.id) });
  } catch (error) {
    next(error);
  }
});

// Starts (or restarts) enrollment. Not yet active -- a real code from an authenticator app,
// via /confirm below, is required before this protects anything, so a secret alone can never
// lock the account out.
router.post("/account/2fa/enroll", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "This is temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const enrollment = await beginTwoFactorEnrollment(user.id, user.email);
    res.status(201).json({ ok: true, secret: enrollment.secret, otpauthUrl: enrollment.otpauthUrl });
  } catch (error) {
    next(error);
  }
});

router.post("/account/2fa/confirm", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "This is temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const { code } = codeSchema.parse(req.body);
    const ok = await confirmTwoFactorEnrollment(user.id, user.email, code);
    if (!ok) {
      res.status(400).json({ ok: false, error: "That code didn't match. Try the next code your app shows." });
      return;
    }
    res.json({ ok: true, enabled: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Enter the 6-digit code." });
      return;
    }
    next(error);
  }
});

// A stolen session cookie alone must not be enough to turn OFF a real security control --
// disabling requires a current code, proving the caller still has the authenticator, the same
// way turning it on did.
router.post("/account/2fa/disable", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "This is temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const { code } = codeSchema.parse(req.body);
    const ok = await verifyCurrentTwoFactorCode(user.id, user.email, code);
    if (!ok) {
      res.status(401).json({ ok: false, error: "That code is invalid." });
      return;
    }
    await disableTwoFactor(user.id);
    res.json({ ok: true, enabled: false });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Enter the 6-digit code." });
      return;
    }
    next(error);
  }
});

export default router;
