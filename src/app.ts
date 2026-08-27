import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import router from "./routes/index.js";
import { logger } from "./lib/logger.js";
import { createX402Middleware, MACHINE_ROUTE_PATH } from "./lib/x402.js";
import { stripeWebhookHandler } from "./lib/billing.js";
import authRouter from "./routes/auth.js";

const app: Express = express();
const createPinoHttp = pinoHttp as unknown as (options: any) => express.RequestHandler;

app.use(
  createPinoHttp({
    logger,
    serializers: {
      req(req: any) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res: any) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.disable("x-powered-by");
const allowedOrigins = new Set(["https://obsidian-abyss.xyz", "https://www.obsidian-abyss.xyz", ...(process.env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean)]);
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)), credentials: true }));
app.use(cookieParser());
// Stripe requires the untouched raw request body for signed webhook verification.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/api", authRouter);

// Agentic access (x402): gates only MACHINE_ROUTE_PATH when X402_ENABLED=true.
// Off/unconfigured => middleware is null and the route stays free. Human endpoints are never gated.
let x402Middleware: ReturnType<typeof createX402Middleware> = null;
try {
  x402Middleware = createX402Middleware();
} catch (err) {
  logger.error({ err }, "x402 init failed - continuing without agentic access");
}
if (x402Middleware) {
  app.use(x402Middleware);
  logger.info({ route: MACHINE_ROUTE_PATH }, "x402 agentic access ENABLED");
} else {
  logger.info("x402 agentic access off (disabled, unconfigured, or facilitator unavailable)");
}

app.use("/api", router);

if (process.env.NODE_ENV === "production") {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const frontendDist = path.join(__dirname, "../../webapp-frontend/dist");

  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
    } else {
      logger.warn(
        { frontendDist },
        "Frontend dist not found - skipping static serving",
      );
    }
  }

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error(err);
    res.status(500).json({ ok: false, error: "Internal server error" });
  },
);

export default app;
