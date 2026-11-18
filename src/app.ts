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
import { allowedOrigins } from "./lib/origins.js";

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
app.use(cors({ origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)), credentials: true }));
app.use(cookieParser());
// The server's OWN check, independent of the cors() setting above (which only controls whether
// a browser is allowed to READ the response -- it does not stop the server from PROCESSING a
// request). Browsers always send Origin on a cross-site state-changing request; a same-origin
// request from our own frontend, or a non-browser caller (curl, a server-to-server webhook,
// this very test), sends no Origin at all. So: no Origin header -> allow (not the CSRF threat
// model); an Origin header present and not one of ours -> refuse. Applies to every state-
// changing method so every future route inherits it automatically.
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
    next();
    return;
  }
  const origin = req.headers.origin;
  if (!origin || allowedOrigins.has(origin)) {
    next();
    return;
  }
  res.status(403).json({ ok: false, error: "That request came from somewhere else, so we ignored it." });
});
// Stripe requires the untouched raw request body for signed webhook verification.
app.post("/api/billing/webhook", express.raw({ type: "application/json" }), stripeWebhookHandler);
app.use(express.text({ type: ["text/csv", "text/plain"], limit: "5mb" }));
app.use(express.json({ limit: "5mb" }));
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
    const statusCode = err && typeof err === "object" && "statusCode" in err && Number.isInteger(Number(err.statusCode))
      ? Number(err.statusCode)
      : 500;
    res.status(statusCode).json({ ok: false, error: statusCode === 500 ? "Internal server error" : String((err as Error).message) });
  },
);

export default app;
