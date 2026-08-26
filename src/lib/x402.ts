import { HTTPFacilitatorClient } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { declareBuilderCodeExtension } from "@x402/extensions";
import { registerExactEvmScheme } from "@x402/evm/exact/server";
import { facilitator as cdpFacilitator } from "@coinbase/x402";
import type { RequestHandler } from "express";

const BUILDER_CODE_PATTERN = /^[a-z0-9_]{1,32}$/;
const DEFAULT_RECEIVING_ADDRESS = "0xD0c7ac431D98e47230EF86E3391128D3aD0C6b13";

// The single agent route x402 gates. Full path as Express sees it (router is mounted at /api).
export const MACHINE_ROUTE_PATH = "/api/machine/backtesting";

// When CDP credentials are present we use Coinbase's Base-native facilitator
// (production-grade, carries CDP auth headers for verify/settle/supported). Otherwise we fall
// back to a plain HTTP facilitator URL (e.g. x402.rs / x402.org on testnet). Same code path
// for both phases -- the operator switches by setting CDP_API_KEY_ID + CDP_API_KEY_SECRET.
function useCdpFacilitator(): boolean {
  return Boolean(process.env.CDP_API_KEY_ID && process.env.CDP_API_KEY_SECRET);
}

function cfg() {
  return {
    enabled: process.env.X402_ENABLED === "true",
    facilitatorUrl: (process.env.X402_FACILITATOR_URL || "https://x402.org/facilitator").trim(),
    receivingAddress: (process.env.X402_RECEIVING_ADDRESS || DEFAULT_RECEIVING_ADDRESS).trim(),
    network: (process.env.X402_NETWORK || "eip155:84532").trim(),
    amount: (process.env.X402_AMOUNT || "$0.01").trim(),
    currency: (process.env.X402_CURRENCY || "USDC").trim(),
    builderCode: (process.env.X402_BUILDER_CODE || "").trim(),
    publicApiUrl: (process.env.PUBLIC_API_URL || "").replace(/\/$/, ""),
  };
}

export function isX402Configured(): boolean {
  const c = cfg();
  // With CDP the facilitator URL comes from @coinbase/x402, so it isn't required as an env var.
  const facilitatorReady = useCdpFacilitator() || Boolean(c.facilitatorUrl);
  return Boolean(
    c.enabled && facilitatorReady && c.receivingAddress && c.network && c.amount && c.publicApiUrl,
  );
}

export function getX402Status() {
  const c = cfg();
  const cdp = useCdpFacilitator();
  return {
    enabled: isX402Configured(),
    protocol: "x402",
    version: "v2",
    route: MACHINE_ROUTE_PATH,
    facilitator: cdp ? "coinbase-cdp" : "http-url",
    facilitatorUrl: cdp ? "https://api.cdp.coinbase.com" : c.facilitatorUrl,
    network: c.network,
    receivingAddress: c.receivingAddress,
    currency: c.currency,
    amount: c.amount,
    builderCode: c.builderCode || null,
  };
}

function routeConfig() {
  const c = cfg();
  if (!c.publicApiUrl || !c.receivingAddress || !c.network || !c.amount) return null;
  return {
    [`GET ${MACHINE_ROUTE_PATH}`]: {
      accepts: {
        scheme: "exact",
        price: c.amount,
        network: c.network,
        payTo: c.receivingAddress,
        maxTimeoutSeconds: 120,
        extra: { surface: "agentic", route: "backtesting" },
      },
      resource: `${c.publicApiUrl}${MACHINE_ROUTE_PATH}`,
      description: "Paid agent access to the regime + backtesting research payload",
      mimeType: "application/json",
      serviceName: "Obsidian Abyss",
      tags: ["agent", "backtesting", "x402"],
      extensions: BUILDER_CODE_PATTERN.test(c.builderCode)
        ? { ...declareBuilderCodeExtension(c.builderCode) }
        : undefined,
    },
  };
}

// Returns the x402 payment middleware, or null when disabled/unconfigured (route stays free).
export function createX402Middleware(): RequestHandler | null {
  if (!isX402Configured()) return null;
  const c = cfg();
  const routes = routeConfig();
  if (!routes) return null;

  const facilitatorClient = useCdpFacilitator()
    ? new HTTPFacilitatorClient(cdpFacilitator)
    : new HTTPFacilitatorClient({ url: c.facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient);
  registerExactEvmScheme(resourceServer, { networks: [c.network as `${string}:${string}`] });

  return paymentMiddleware(routes as any, resourceServer) as unknown as RequestHandler;
}
