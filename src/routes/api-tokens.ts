import { Router } from "express";
import { z } from "zod";
import { apiTokensConfigured, createApiToken, currentUser, databaseReady, listApiTokens, revokeApiToken } from "../lib/account.js";
import { logActivity } from "../lib/activity-log.js";

const router = Router();

const createSchema = z.object({ name: z.string().trim().min(1).max(80) });
const jtiSchema = z.string().uuid();

router.post("/account/tokens", async (req, res, next) => {
  try {
    if (!databaseReady() || !apiTokensConfigured()) {
      res.status(503).json({ ok: false, error: "API tokens are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const { name } = createSchema.parse(req.body);
    const created = await createApiToken(user.id, name);
    await logActivity(user.id, "api_token_created", { name, jti: created.jti });
    // The token itself is returned exactly once, here, and never stored in a readable form --
    // the same UX every real API-token feature uses, because there is nothing else to protect
    // if the value can be fetched again later.
    res.status(201).json({ ok: true, token: created.token, id: created.jti, expiresAt: created.expiresAt });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "Please enter a name between 1 and 80 characters." });
      return;
    }
    next(error);
  }
});

router.get("/account/tokens", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "API tokens are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    res.json({ ok: true, tokens: await listApiTokens(user.id) });
  } catch (error) {
    next(error);
  }
});

router.delete("/account/tokens/:jti", async (req, res, next) => {
  try {
    if (!databaseReady()) {
      res.status(503).json({ ok: false, error: "API tokens are temporarily unavailable." });
      return;
    }
    const user = await currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const jti = jtiSchema.parse(req.params.jti);
    const revoked = await revokeApiToken(user.id, jti);
    if (!revoked) {
      res.status(404).json({ ok: false, error: "Not found." });
      return;
    }
    await logActivity(user.id, "api_token_revoked", { jti });
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({ ok: false, error: "That is not a valid token id." });
      return;
    }
    next(error);
  }
});

export default router;
