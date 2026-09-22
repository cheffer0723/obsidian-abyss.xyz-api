import app from "./app.js";
import { logger } from "./lib/logger.js";
import { warmTestingMarketHistory } from "./lib/testing-market-history.js";

const rawPort = process.env.PORT || "3001";
const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// An optional integration (e.g. the x402 facilitator handshake) must never crash the
// core app. Log async failures and keep serving Hexagon / backtests / emotion.
process.on("unhandledRejection", (reason) => {
  logger.error(
    { reason: reason instanceof Error ? reason.message : String(reason) },
    "unhandledRejection - continuing to serve",
  );
});

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  void warmTestingMarketHistory().catch((error) => {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Harness market history not warmed at boot; first replay will retry",
    );
  });
});
