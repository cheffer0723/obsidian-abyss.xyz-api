import type { Request, RequestHandler } from "express";
import { currentUser, databaseReady, entitlementFor } from "./account.js";

type AccessDependencies = {
  databaseReady: () => boolean;
  currentUser: (req: Request) => Promise<{ id: string; email: string } | null>;
  entitlementFor: (userId: string) => Promise<{ active: boolean; status: string | null }>;
};

export function createRequireActiveSubscription(dependencies: AccessDependencies): RequestHandler {
  return async (req, res, next) => {
  try {
    if (!dependencies.databaseReady()) {
      res.status(503).json({ ok: false, error: "Account access is temporarily unavailable." });
      return;
    }
    const user = await dependencies.currentUser(req);
    if (!user) {
      res.status(401).json({ ok: false, error: "Sign-in is required." });
      return;
    }
    const entitlement = await dependencies.entitlementFor(user.id);
    if (!entitlement.active) {
      res.status(403).json({ ok: false, error: "An active subscription is required." });
      return;
    }
    res.locals.user = { id: user.id, email: user.email };
    next();
  } catch (error) {
    next(error);
  }
  };
}

export const requireActiveSubscription = createRequireActiveSubscription({ databaseReady, currentUser, entitlementFor });
