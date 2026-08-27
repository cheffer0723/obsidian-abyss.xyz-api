import Stripe from "stripe";
import type { RequestHandler } from "express";
import { logger } from "./logger.js";
import { bindStripeCustomer, currentUser, upsertEntitlement } from "./account.js";

type BillingConfig = {
  secretKey: string;
  priceId: string;
  successUrl: string;
  cancelUrl: string;
  webhookSecret: string;
  testMode: boolean;
};

function configuredValue(name: string): string {
  return (process.env[name] || "").trim();
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function billingConfig(): BillingConfig {
  const secretKey = configuredValue("STRIPE_SECRET_KEY");
  const priceId = configuredValue("STRIPE_PRICE_ID");
  const successUrl = configuredValue("BILLING_SUCCESS_URL");
  const cancelUrl = configuredValue("BILLING_CANCEL_URL");
  const webhookSecret = configuredValue("STRIPE_WEBHOOK_SECRET");
  const testMode = secretKey.startsWith("sk_test_");

  if (!secretKey || !priceId || !isHttpsUrl(successUrl) || !isHttpsUrl(cancelUrl)) {
    throw new Error("Stripe Checkout is not configured.");
  }
  if (!testMode && process.env.BILLING_ALLOW_LIVE !== "true") {
    throw new Error("Live Stripe billing is disabled until fulfilment is configured.");
  }
  return { secretKey, priceId, successUrl, cancelUrl, webhookSecret, testMode };
}

function stripe(config: BillingConfig): Stripe {
  return new Stripe(config.secretKey, { apiVersion: "2026-07-29.dahlia" });
}

export function getBillingStatus() {
  const secretKey = configuredValue("STRIPE_SECRET_KEY");
  const priceId = configuredValue("STRIPE_PRICE_ID");
  const successUrl = configuredValue("BILLING_SUCCESS_URL");
  const cancelUrl = configuredValue("BILLING_CANCEL_URL");
  const webhookSecret = configuredValue("STRIPE_WEBHOOK_SECRET");
  const testMode = secretKey.startsWith("sk_test_");
  return {
    checkoutReady: Boolean(secretKey && priceId && isHttpsUrl(successUrl) && isHttpsUrl(cancelUrl) && (testMode || process.env.BILLING_ALLOW_LIVE === "true")),
    webhookReady: Boolean(webhookSecret),
    testMode,
    liveBillingEnabled: process.env.BILLING_ALLOW_LIVE === "true",
    fulfilment: "manual-pending",
  };
}

export async function createCheckoutSession(req: Parameters<RequestHandler>[0]): Promise<{ url: string }> {
  const config = billingConfig();
  const user = await currentUser(req);
  if (!user) throw new Error("Authentication is required before checkout.");
  const client = stripe(config);
  const price = await client.prices.retrieve(config.priceId);
  if (
    !price.active ||
    price.currency !== "usd" ||
    price.unit_amount !== 999 ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1
  ) {
    throw new Error("The configured Stripe Price must be an active $9.99 USD monthly subscription.");
  }
  const session = await client.checkout.sessions.create({
    mode: "subscription",
    line_items: [{ price: config.priceId, quantity: 1 }],
    success_url: config.successUrl,
    cancel_url: config.cancelUrl,
    allow_promotion_codes: true,
    customer_email: user.email,
    subscription_data: { metadata: { product: "obsidian-abyss", user_id: user.id } },
    metadata: { product: "obsidian-abyss", user_id: user.id },
  });
  if (typeof session.customer === "string") await bindStripeCustomer(user.id, session.customer);
  if (!session.url) throw new Error("Stripe did not return a Checkout URL.");
  return { url: session.url };
}

export const stripeWebhookHandler: RequestHandler = async (req, res) => {
  try {
    const config = billingConfig();
    if (!config.webhookSecret) {
      res.status(503).json({ ok: false, error: "Stripe webhook verification is not configured." });
      return;
    }
    const signature = req.header("stripe-signature");
    if (!signature || !Buffer.isBuffer(req.body)) {
      res.status(400).json({ ok: false, error: "Invalid Stripe webhook request." });
      return;
    }
    const event = stripe(config).webhooks.constructEvent(req.body, signature, config.webhookSecret);
    const object = event.data.object as Record<string, any>;
    if (event.type === "checkout.session.completed" && typeof object.customer === "string" && typeof object.metadata?.user_id === "string") await bindStripeCustomer(object.metadata.user_id, object.customer);
    if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type) && typeof object.customer === "string") {
      if (typeof object.metadata?.user_id === "string") await bindStripeCustomer(object.metadata.user_id, object.customer);
      await upsertEntitlement(object.customer, object.id, object.status || (event.type.endsWith("deleted") ? "canceled" : "unknown"), object.current_period_end || null);
    }
    logger.info(
      { stripeEventType: event.type, stripeEventId: event.id, livemode: event.livemode },
      "Verified Stripe webhook; entitlement fulfilment remains manual",
    );
    res.json({ received: true });
  } catch (error) {
    logger.warn({ stripeWebhookError: error instanceof Error ? error.message : "unknown" }, "Stripe webhook signature verification failed");
    res.status(400).json({ ok: false, error: "Invalid Stripe webhook signature." });
  }
};
