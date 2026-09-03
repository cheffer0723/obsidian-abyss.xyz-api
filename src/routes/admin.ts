import { Router } from "express";
import { z } from "zod";
import { getAdminOverview } from "../lib/account.js";
import { requireAdmin } from "../lib/access.js";

const router = Router();
const windowSchema = z.enum(["7", "30"]).catch("7");

router.get("/admin/overview", requireAdmin, async (req, res, next) => {
  try {
    const windowDays = Number(windowSchema.parse(req.query.window)) as 7 | 30;
    res.json({ ok: true, overview: await getAdminOverview(windowDays) });
  } catch (error) {
    next(error);
  }
});

export default router;
