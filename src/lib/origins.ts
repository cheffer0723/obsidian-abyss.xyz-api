// The one list of sites allowed to talk to this API with a browser's cookies attached.
// Shared so the CORS setting (app.ts) and the same-origin check on state-changing
// requests (access.ts) can never drift apart into two different lists.
export const allowedOrigins = new Set([
  "https://obsidian-abyss.xyz",
  "https://www.obsidian-abyss.xyz",
  "https://obsidianabyss.com",
  "https://www.obsidianabyss.com",
  ...(process.env.ALLOWED_ORIGINS || "").split(",").map((origin) => origin.trim()).filter(Boolean),
]);

export function isAllowedOrigin(origin: string): boolean {
  return allowedOrigins.has(origin);
}
