import { Router } from "express";
import { z } from "zod";
import { createAuthorizationCode, currentUser, databaseReady, exchangeAuthorizationCode, registerOAuthClient } from "../lib/account.js";
import { logActivity } from "../lib/activity-log.js";

const router = Router();

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  redirectUris: z.array(z.string().trim().url().max(500)).min(1).max(10),
});

// Any signed-in user may register their own client -- the common "create an app" pattern in
// a developer-settings page. Not owner-only; nothing here grants elevated access.
router.post("/account/oauth-clients", async (req, res, next) => {
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
    const { name, redirectUris } = registerSchema.parse(req.body);
    const client = await registerOAuthClient(user.id, name, redirectUris);
    await logActivity(user.id, "oauth_client_registered", { name, clientId: client.clientId });
    // The secret is returned exactly once, the same as an API token -- there is nothing to
    // protect by storing it in a readable form.
    res.status(201).json({ ok: true, clientId: client.clientId, clientSecret: client.clientSecret });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Please check the name and redirect URLs." });
      return;
    }
    next(error);
  }
});

const authorizeSchema = z.object({
  client_id: z.string().uuid(),
  redirect_uri: z.string().trim().url(),
  response_type: z.literal("code"),
  state: z.string().max(500).optional(),
});

// A signed-in user approves a client reaching their account. This demo skips a separate
// consent-screen click (every signed-in request here approves) -- the security property under
// test is the exact redirect_uri match, which createAuthorizationCode enforces either way.
router.get("/oauth/authorize", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "This is temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required before authorizing a client." });
      return;
    }
    const parsed = authorizeSchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ ok: false, error: "A valid client_id, redirect_uri and response_type=code are required." });
      return;
    }
    const { client_id, redirect_uri, state } = parsed.data;
    const result = await createAuthorizationCode(user.id, client_id, redirect_uri);
    if (!result.ok) {
      // Never redirect on a mismatch -- that would itself be the open-redirect/redirect_uri
      // bug this feature exists to prove is absent. Answer in place instead.
      res.status(400).json({ ok: false, error: result.reason === "unknown_client" ? "Unknown client." : "redirect_uri is not registered for this client." });
      return;
    }
    const location = new URL(redirect_uri);
    location.searchParams.set("code", result.code);
    if (state) location.searchParams.set("state", state);
    res.redirect(location.toString());
  } catch (error) {
    next(error);
  }
});

const tokenSchema = z.object({
  grant_type: z.literal("authorization_code"),
  code: z.string().min(10).max(200),
  client_id: z.string().uuid(),
  client_secret: z.string().min(10).max(200),
  redirect_uri: z.string().trim().url(),
});

router.post("/oauth/token", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "This is temporarily unavailable." });
      return;
    }
    const { code, client_id, client_secret, redirect_uri } = tokenSchema.parse(req.body);
    const result = await exchangeAuthorizationCode(code, client_id, client_secret, redirect_uri);
    if (!result.ok) {
      res.status(400).json({ ok: false, error: result.reason === "invalid_client" ? "invalid_client" : "invalid_grant" });
      return;
    }
    res.json({ ok: true, access_token: result.accessToken, token_type: "Bearer", expires_in: result.expiresIn });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "invalid_request" });
      return;
    }
    next(error);
  }
});

export default router;
