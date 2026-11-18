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
import profileRouter from "./profile.js";
import harnessRunsRouter from "./harness-runs.js";
import apiTokensRouter from "./api-tokens.js";
import oauthRouter from "./oauth.js";
import activityRouter from "./activity.js";
import graphqlRouter from "./graphql.js";
import twoFactorRouter from "./two-factor.js";

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
router.use(profileRouter);
router.use(harnessRunsRouter);
router.use(apiTokensRouter);
router.use(oauthRouter);
router.use(activityRouter);
router.use(graphqlRouter);
router.use(twoFactorRouter);

export default router;
