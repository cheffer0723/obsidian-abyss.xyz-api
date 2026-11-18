import { Router } from "express";
import { z } from "zod";
import { confirmEmailChange, currentUser, databaseReady, getProfile, requestEmailChange, setDisplayName } from "../lib/account.js";

function appUrl(): string {
  return (process.env.AUTH_APP_URL || "https://obsidianabyss.com").replace(/\/$/, "");
}

const router = Router();

// The only field a signed-in account can change about itself. Real feature (an account's
// display name) that doubles as the fixture ScamShade's authorized mass-assignment probe
// uses: a role/plan/admin field sent alongside displayName is never read, by construction —
// see setDisplayName in account.ts.
const updateSchema = z.object({ displayName: z.string().trim().min(1).max(80) });
const emailChangeSchema = z.object({ newEmail: z.string().trim().email().max(320) });

router.get("/account/profile", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Accounts are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const profile = await getProfile(user.id);
    res.json({ ok: true, profile: profile ? { email: profile.email, displayName: profile.displayName } : null });
  } catch (error) {
    next(error);
  }
});

router.patch("/account/profile", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Accounts are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const { displayName } = updateSchema.parse(req.body);
    const profile = await setDisplayName(user.id, displayName);
    res.json({ ok: true, profile: { email: profile.email, displayName: profile.displayName } });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Please enter a display name between 1 and 80 characters." });
      return;
    }
    next(error);
  }
});

// The signed-in session alone is NEVER enough to change the login email -- that would let a
// stolen cookie turn straight into a takeover. This only SENDS a confirmation link to the NEW
// address; the account's email does not change until that link is opened, proving control of
// the new address, not just possession of a session.
router.post("/account/email/change", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Accounts are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const { newEmail } = emailChangeSchema.parse(req.body);
    const result = await requestEmailChange(user.id, newEmail);
    if (!result.ok && result.reason === "taken") {
      res.status(409).json({ ok: false, error: "That email is already in use." });
      return;
    }
    res.json({ ok: true, message: "Check the new address for a confirmation link. Nothing changes until it's opened." });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Please enter a valid email address." });
      return;
    }
    next(error);
  }
});

router.get("/account/email/confirm", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Accounts are temporarily unavailable." });
      return;
    }
    const token = z.string().min(20).parse(req.query.token);
    const ok = await confirmEmailChange(token);
    res.redirect(`${appUrl()}/account?emailChange=${ok ? "confirmed" : "invalid"}`);
  } catch {
    res.redirect(`${appUrl()}/account?emailChange=invalid`);
  }
});

export default router;
