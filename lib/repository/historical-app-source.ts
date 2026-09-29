import { z } from "zod";

const objectId = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const repositoryId = z.string().regex(/^[1-9]\d*$/u);
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/u);

export const historicalAppSourceSelectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    commitSha: objectId,
    kind: z.literal("commit"),
  }),
  z.strictObject({
    kind: z.literal("merged-pr"),
    pullRequestNumber: z.number().int().positive(),
  }),
]);

export const historicalAppSourceObservationSchema = z.strictObject({
  commitSha: objectId,
  name: repositoryName,
  owner: repositoryName,
  pullRequestNumber: z.number().int().positive().optional(),
  repositoryId,
  treeSha: objectId,
});

export type HistoricalAppSourceSelector = z.infer<typeof historicalAppSourceSelectorSchema>;
export type HistoricalAppSourceObservation = z.infer<
  typeof historicalAppSourceObservationSchema
>;
