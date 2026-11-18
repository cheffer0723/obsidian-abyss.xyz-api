import path from "node:path";
import { createRequire } from "node:module";

// @seald-io/nedb is a CJS-only package whose .d.ts merges a class and a namespace under one
// `export default` -- TypeScript's NodeNext resolution cannot turn that into a constructable
// type here (a library quirk, not this file's), so this names only the small slice of its
// real API this file actually calls, and loads the real class with require() (the runtime
// value is unaffected either way; createRequire is the same CJS-interop this project's own
// build.mjs banner already relies on).
interface ActivityDatastore {
  insertAsync(doc: Omit<ActivityRow, "_id">): Promise<ActivityRow & { _id: string }>;
  findAsync(query: Record<string, unknown>): Promise<(ActivityRow & { _id: string })[]>;
}
const require = createRequire(import.meta.url);
const NedbCtor = require("@seald-io/nedb") as new (options: { filename: string; autoload: boolean }) => ActivityDatastore;

// A genuinely better fit for a document store than a SQL table: different activity types
// carry different fields (a token's name, a client's redirect URIs, a report's run id), and
// the shape keeps growing as more kinds of activity get logged. Not a replacement for
// Postgres -- a small side-store for one kind of flexible-schema data, alongside it.
//
// Known limitation, stated plainly rather than hidden: this file lives on local disk, not in
// a Railway volume, so a redeploy resets it. Acceptable for a recent-activity feed; it is not
// used for anything the product depends on for correctness.
const db = new NedbCtor({ filename: path.resolve(process.cwd(), "data/activity-log.db"), autoload: true });

export type ActivityType = "api_token_created" | "api_token_revoked" | "oauth_client_registered" | "report_exported";
type ActivityRow = { userId: string; type: ActivityType; detail: Record<string, unknown>; createdAt: string };
export type ActivityEntry = ActivityRow & { id: string };

export async function logActivity(userId: string, type: ActivityType, detail: Record<string, unknown>): Promise<void> {
  await db.insertAsync({ userId, type, detail, createdAt: new Date().toISOString() });
}

// The defense against NoSQL operator injection ($ne/$gt/$regex) is at the CALLER: a route
// must validate `typeFilter` is a plain string (e.g. with zod) before it ever reaches this
// function, so a request value can never arrive here as an object carrying an operator.
// Verified directly: NeDB genuinely treats {"$ne": "x"} as an operator if given the chance --
// this function does not re-sanitize that, because sanitizing "late" is easy to forget to do
// consistently; the one enforced rule is that userId is applied LAST, so nothing a caller
// builds from request data can widen a search past the signed-in user's own records.
export async function searchActivity(userId: string, typeFilter?: string): Promise<ActivityEntry[]> {
  const filter: Record<string, unknown> = {};
  if (typeFilter !== undefined) filter.type = typeFilter;
  filter.userId = userId;
  const rows = await db.findAsync(filter);
  return rows.map((r: ActivityRow & { _id: string }) => ({ id: r._id, userId: r.userId, type: r.type, detail: r.detail, createdAt: r.createdAt }));
}
