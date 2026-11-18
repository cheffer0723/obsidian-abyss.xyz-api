import { Router } from "express";
import { z } from "zod";
import { currentUser, databaseReady, getProfile, setDisplayName } from "../lib/account.js";

const router = Router();

// The only field a signed-in account can change about itself. Real feature (an account's
// display name) that doubles as the fixture ScamShade's authorized mass-assignment probe
// uses: a role/plan/admin field sent alongside displayName is never read, by construction —
// see setDisplayName in account.ts.
const updateSchema = z.object({ displayName: z.string().trim().min(1).max(80) });

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

export default router;
