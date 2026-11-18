import { Router } from "express";
import { z } from "zod";
import {
  createHarnessRun,
  currentUser,
  databaseReady,
  getHarnessRun,
  getHarnessRunsByIds,
  listHarnessRunsByUser,
  renameHarnessRun,
} from "../lib/account.js";
import { renderReportPdf } from "../lib/reports.js";

const router = Router();

const nameSchema = z.object({ name: z.string().trim().min(1).max(200) });
const idsQuerySchema = z.object({ ids: z.string().trim().min(1).max(2000).optional() });
const uuidSchema = z.string().uuid();
const batchBodySchema = z.object({ ids: z.array(uuidSchema).min(1).max(20) });

function asRun(run: { id: string; name: string; createdAt: string }) {
  return { id: run.id, name: run.name, createdAt: run.createdAt };
}

router.post("/harness/runs", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Saved runs are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const { name } = nameSchema.parse(req.body);
    const run = await createHarnessRun(user.id, name);
    res.status(201).json({ ok: true, run: asRun(run) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Please enter a name between 1 and 200 characters." });
      return;
    }
    next(error);
  }
});

// The conventional batch shape: a POST body carrying the ids, for a longer list than fits
// comfortably in a query string. Same ownership filter as every other read here -- every row
// fetched is checked against the caller AFTER fetching, not trusted because it arrived in a
// batch.
router.post("/harness/runs/batch", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Saved runs are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const { ids } = batchBodySchema.parse(req.body);
    const rows = await getHarnessRunsByIds(ids);
    const mine = rows.filter((r) => r.userId === user.id).map(asRun);
    res.json({ ok: true, runs: mine });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Send 1 to 20 valid run ids." });
      return;
    }
    next(error);
  }
});

// With ?ids=a,b,c: every id the caller asked for that they also own -- others are silently
// left out, not reported as denied, so this never confirms or denies which ids exist at all.
// With no ids: the caller's own full list.
router.get("/harness/runs", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Saved runs are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const { ids: idsParam } = idsQuerySchema.parse(req.query);
    const requested = idsParam
      ? idsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20)
      : null;
    if (requested && !requested.every((id) => uuidSchema.safeParse(id).success)) {
      res.status(400).json({ ok: false, error: "Each id must be a valid run id." });
      return;
    }
    // Same ownership check either way: every row is checked against this caller, one row at a
    // time, whether it arrived as a single id, a batch of ids, or the caller's own full list.
    const rows = requested ? await getHarnessRunsByIds(requested) : await listHarnessRunsByUser(user.id);
    const mine = rows.filter((r) => r.userId === user.id).map(asRun);
    res.json({ ok: true, runs: mine });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "That request could not be read." });
      return;
    }
    next(error);
  }
});

router.get("/harness/runs/:id", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Saved runs are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const id = uuidSchema.parse(req.params.id);
    const run = await getHarnessRun(id);
    if (!run || run.userId !== user.id) {
      res.status(404).json({ ok: false, error: "Not found." });
      return;
    }
    res.json({ ok: true, run: asRun(run) });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "That is not a valid run id." });
      return;
    }
    next(error);
  }
});

// A real export a user actually wants: their own run as a PDF, suitable for keeping or sharing
// outside the app. Same ownership check as the read above; the PDF is rendered from a fixed
// template with the run's own fields as data (see src/lib/reports.ts for why that is safe).
router.get("/harness/runs/:id/report.pdf", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Saved runs are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const id = uuidSchema.parse(req.params.id);
    const run = await getHarnessRun(id);
    if (!run || run.userId !== user.id) {
      res.status(404).json({ ok: false, error: "Not found." });
      return;
    }
    const pdf = await renderReportPdf({ id: run.id, name: run.name, createdAt: run.createdAt });
    res.setHeader("content-type", "application/pdf");
    res.setHeader("content-disposition", `attachment; filename="backtest-report-${run.id}.pdf"`);
    res.send(pdf);
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "That is not a valid run id." });
      return;
    }
    next(error);
  }
});

router.patch("/harness/runs/:id", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "Saved runs are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const id = uuidSchema.parse(req.params.id);
    const existing = await getHarnessRun(id);
    if (!existing || existing.userId !== user.id) {
      res.status(404).json({ ok: false, error: "Not found." });
      return;
    }
    const { name } = nameSchema.parse(req.body);
    const run = await renameHarnessRun(id, name);
    res.json({ ok: true, run: run ? asRun(run) : null });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Please check the fields and try again." });
      return;
    }
    next(error);
  }
});

export default router;
