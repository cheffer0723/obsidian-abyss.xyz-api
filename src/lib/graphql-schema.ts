import { buildSchema, GraphQLError } from "graphql";
import type { ValidationRule } from "graphql";
import { getHarnessRun, listHarnessRunsByUser } from "./account.js";

// Read-only on purpose: every field here only ever returns data the CALLER already owns
// (see resolvers below). There is no mutation, and nothing a signed-in user couldn't already
// fetch through the plain REST routes -- GraphQL is offered as an alternative shape for
// integrations that want flexible, client-driven queries over the same data, not a wider door.
export const schema = buildSchema(`
  type HarnessRun {
    id: ID!
    name: String!
    createdAt: String!
  }

  type Query {
    myRuns: [HarnessRun!]!
    run(id: ID!): HarnessRun
  }
`);

export type GraphQLContext = { userId: string };

export const rootValue = {
  myRuns: async (_args: unknown, context: GraphQLContext) => listHarnessRunsByUser(context.userId),
  run: async (args: { id: string }, context: GraphQLContext) => {
    const run = await getHarnessRun(args.id);
    // Same ownership check as every other read in this app: fetched first, then compared.
    return run && run.userId === context.userId ? run : null;
  },
};

// A basic, deliberately simple query-size guard: a signed document with more than a modest
// number of field selections (covers both deep nesting AND wide alias-batching -- a batch of
// aliased copies of the same field each count toward this total, same as a deeply nested
// chain would) is rejected before execution ever starts. There is no sensitive, state-changing
// operation behind this schema for a batch to usefully attack, but the limit costs nothing and
// is simple, standard practice regardless.
const MAX_FIELD_SELECTIONS = 40;

export const fieldCountLimit: ValidationRule = (context) => {
  let count = 0;
  return {
    Field() {
      count += 1;
      if (count > MAX_FIELD_SELECTIONS) {
        context.reportError(new GraphQLError(`This query selects too many fields (over ${MAX_FIELD_SELECTIONS}).`));
      }
    },
  };
};
