import { Router } from "express";
import { createCheckoutSession, getBillingStatus } from "../lib/billing.js";
import { logger } from "../lib/logger.js";

const router = Router();

router.get("/billing/status", (_req, res) => {
  res.json({ ok: true, billing: getBillingStatus() });
});

router.post("/billing/checkout", async (_req, res) => {
  try {
    const session = await createCheckoutSession();
    res.json({ ok: true, ...session });
  } catch (error) {
    const safeConfigurationErrors = [
      "Stripe Checkout is not configured.",
      "Live Stripe billing is disabled until fulfilment is configured.",
      "The configured Stripe Price must be an active $9.99 USD monthly subscription.",
    ];
    const rawMessage = error instanceof Error ? error.message : "";
    logger.warn({ stripeCheckoutError: error instanceof Error ? error.name : "unknown" }, "Stripe Checkout Session creation failed");
    const message = safeConfigurationErrors.includes(rawMessage) ? rawMessage : "Stripe Checkout is unavailable. Please try again shortly.";
    res.status(503).json({ ok: false, error: message });
  }
});

export default router;
