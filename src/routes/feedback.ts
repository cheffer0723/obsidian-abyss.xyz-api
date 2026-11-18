import { Router } from "express";
import { z } from "zod";
import { currentUser, databaseReady, getBetaFeedbackById, listBetaFeedback, resolveBetaFeedback, submitBetaFeedback } from "../lib/account.js";
import { requireAdmin } from "../lib/access.js";

const router = Router();

const resolveBody = z.object({ resolved: z.boolean() });
const uuidSchema = z.string().uuid();

const feedbackBody = z.object({
  category: z.enum(["comment", "concern", "bug", "idea"]),
  message: z.string().trim().min(8).max(4000),
  contactEmail: z.string().trim().email().optional().or(z.literal("")),
  pagePath: z.string().trim().max(200).optional().or(z.literal("")),
});

const recentByIp = new Map<string, number[]>();

function allowSubmission(ip: string): boolean {
  const now = Date.now();
  const windowMs = 15 * 60 * 1000;
  const max = 5;
  const stamps = (recentByIp.get(ip) || []).filter((t) => now - t < windowMs);
  if (stamps.length >= max) {
    recentByIp.set(ip, stamps);
    return false;
  }
  stamps.push(now);
  recentByIp.set(ip, stamps);
  return true;
}

router.post("/feedback", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Feedback is temporarily unavailable." });
      return;
    }
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown")
      .split(",")[0]
      .trim();
    if (!allowSubmission(ip)) {
      res.status(429).json({ ok: false, error: "Too many feedback submissions. Please try again later." });
      return;
    }
    const body = feedbackBody.parse(req.body);
    const user = await currentUser(req).catch(() => null);
    const result = await submitBetaFeedback({
      category: body.category,
      message: body.message,
      contactEmail: body.contactEmail || null,
      pagePath: body.pagePath || null,
      userAgent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"] : null,
      userId: user?.id || null,
    });
    res.status(201).json({ ok: true, id: result.id });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Please check the feedback fields and try again." });
      return;
    }
    if (error instanceof Error && /Feedback must be between|contact email/i.test(error.message)) {
      res.status(400).json({ ok: false, error: error.message });
      return;
    }
    next(error);
  }
});

router.get("/admin/feedback", requireAdmin, async (req, res, next) => {
  try {
    const limit = Number(req.query.limit || 50);
    res.json({ ok: true, feedback: await listBetaFeedback(Number.isFinite(limit) ? limit : 50) });
  } catch (error) {
    next(error);
  }
});

// A single item, by id -- the natural sibling of the write below, and a way to check one
// item's state without reading the whole list.
router.get("/admin/feedback/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = uuidSchema.parse(req.params.id);
    const row = await getBetaFeedbackById(id);
    if (!row) {
      res.status(404).json({ ok: false, error: "Not found." });
      return;
    }
    res.json({ ok: true, feedback: row });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "That is not a valid feedback id." });
      return;
    }
    next(error);
  }
});

// The one admin WRITE action in this app: mark a piece of feedback resolved or not, after
// triage. requireAdmin is the only check -- it's the same guard the read route above uses,
// so this proves whether a normal signed-in account can also reach a real admin ACTION, not
// just a read.
router.patch("/admin/feedback/:id", requireAdmin, async (req, res, next) => {
  try {
    const id = uuidSchema.parse(req.params.id);
    const { resolved } = resolveBody.parse(req.body);
    const row = await resolveBetaFeedback(id, resolved);
    if (!row) {
      res.status(404).json({ ok: false, error: "Not found." });
      return;
    }
    res.json({ ok: true, feedback: row });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "That request could not be read." });
      return;
    }
    next(error);
  }
});

export default router;
