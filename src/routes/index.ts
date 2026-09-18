import { Router } from "express";
import emotionRouter from "./emotion.js";
import healthRouter from "./health.js";
import machineRouter from "./machine.js";
import hexagonRouter from "./hexagon.js";
import backtestsRouter from "./backtests.js";
import billingRouter from "./billing.js";
import testingHarnessRouter from "./testing-harness.js";
import adminRouter from "./admin.js";
import feedbackRouter from "./feedback.js";

const router = Router();

router.use(healthRouter);
router.use(emotionRouter);
router.use(machineRouter);
router.use(hexagonRouter);
router.use(backtestsRouter);
router.use(billingRouter);
router.use(testingHarnessRouter);
router.use(adminRouter);
router.use(feedbackRouter);

export default router;
