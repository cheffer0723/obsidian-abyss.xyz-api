import assert from "node:assert/strict";

const apiBase = (process.env.API_BASE || "https://webapp-backend-production-7f0f.up.railway.app/api").replace(/\/+$/, "");
const attempts = Number(process.env.X402_ATTEMPTS || "3");

async function request(path) {
  const response = await fetch(`${apiBase}${path}`);
  const body = await response.text();
  return { response, body };
}

const health = await request("/healthz");
assert.equal(health.response.status, 200, `Health check failed: ${health.body}`);
assert.equal(JSON.parse(health.body).status, "ok", "Health payload must report ok");

const engines = await request("/backtests/engines");
assert.equal(engines.response.status, 200, `Engine data failed: ${engines.body.slice(0, 200)}`);
assert.ok(Array.isArray(JSON.parse(engines.body).engines), "Engine data must contain engines");

const status = await request("/machine/status");
assert.equal(status.response.status, 200, `x402 status failed: ${status.body}`);
const x402 = JSON.parse(status.body).status;
assert.equal(x402.enabled, true, "x402 must be enabled before checking the paid route");
assert.equal(x402.protocol, "x402", "Machine route must advertise x402");

const challenges = await Promise.all(Array.from({ length: attempts }, () => request("/machine/backtesting")));
for (const challenge of challenges) {
  assert.equal(challenge.response.status, 402, "Unpaid machine request must return 402");
  assert.ok(challenge.response.headers.get("payment-required"), "402 response must include payment-required metadata");
}

console.log(JSON.stringify({ ok: true, apiBase, x402Attempts: attempts, checks: ["health", "engine-data", "x402-status", "402-challenge"] }));
