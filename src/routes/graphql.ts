import { Router, type Request } from "express";
import { createHandler } from "graphql-http/lib/use/express";
import depthLimit from "graphql-depth-limit";
import { currentUser, databaseReady } from "../lib/account.js";
import { fieldCountLimit, rootValue, schema } from "../lib/graphql-schema.js";

const router = Router();

const handler = createHandler({
  schema,
  rootValue,
  // Both rules run before execution starts: a query past either limit is refused outright,
  // the same way a deeply nested query and a wide alias-batch are both refused.
  validationRules: [depthLimit(8), fieldCountLimit],
  context: async (req) => {
    if (!databaseReady()) {
      throw new Error("This is temporarily unavailable.");
    }
    const user = await currentUser(req.raw as Request);
    if (!user) {
      throw new Error("Sign-in is required.");
    }
    return { userId: user.id };
  },
});

router.use("/graphql", handler);

export default router;
