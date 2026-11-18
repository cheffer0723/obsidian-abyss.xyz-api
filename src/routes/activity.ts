import { Router } from "express";
import { z } from "zod";
import { currentUser, databaseReady } from "../lib/account.js";
import { searchActivity } from "../lib/activity-log.js";

const router = Router();

// The one defense against NoSQL operator injection: typeFilter must be a plain string before
// it ever reaches searchActivity. A request like ?type[$ne]=x makes Express parse req.query.type
// as an OBJECT ({ $ne: 'x' }), which z.string() rejects outright -- the operator never reaches
// the query.
const querySchema = z.object({ type: z.string().trim().min(1).max(60).optional() });

router.get("/account/activity", async (req, res, next) => {
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
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "type must be plain text." });
      return;
    }
    const entries = await searchActivity(user.id, parsed.data.type);
    res.json({ ok: true, entries });
  } catch (error) {
    next(error);
  }
});

export default router;
