/* oxlint-disable sonarjs/expression-complexity -- Signed provider identity must match all closed scope facts before retention. */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { CentralHostSetupPlan } from "./central-integration-host-contract";

const id = z.string().min(1).max(256);
const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.origin === value &&
    /^[a-z0-9-]+\.vercel\.app$/u.test(url.hostname) &&
    url.username === "" &&
    url.password === ""
  );
});
export const centralNativeDeploymentReceiptSchema = z.strictObject({
  eventId: id,
  eventType: z.enum(["deployment.created", "deployment.ready"]),
  bodySha256: hash,
  projectId: id,
  teamId: id,
  providerDeploymentId: id,
  immutableOrigin: origin,
});
export type CentralNativeDeploymentReceipt = z.infer<typeof centralNativeDeploymentReceiptSchema>;
const unavailable = () => new Error("central_deployment_receipt_rejected");
const eventSchema = z.object({
  id,
  type: z.enum(["deployment.created", "deployment.ready"]),
  payload: z.object({
    project: z.object({ id }),
    team: z.object({ id }),
    target: z.union([z.null(), z.literal("staging")]),
    deployment: z.object({
      id,
      url: id,
      meta: z.object({ githubCommitRef: id, githubCommitSha: z.string().regex(/^[a-f0-9]{40}$/u) }),
    }),
  }),
});
/** Signature admission precedes parsing. Git facts correlate an already-issued native ID; they never elect a deployment. */
export const verifyCentralNativeDeploymentReceipt = (input: {
  plan: CentralHostSetupPlan;
  raw: Buffer;
  signature: string;
  secret: string;
}): CentralNativeDeploymentReceipt | undefined => {
  if (
    input.raw.byteLength > 262_144 ||
    input.secret.length === 0 ||
    !/^[a-f0-9]{40}$/u.test(input.signature)
  ) {
    throw unavailable();
  }
  const actual = Buffer.from(input.signature, "hex");
  const expected = createHmac("sha1", input.secret).update(input.raw).digest();
  if (!timingSafeEqual(actual, expected)) {
    throw unavailable();
  }
  let payload: unknown;
  try {
    payload = JSON.parse(input.raw.toString("utf-8"));
  } catch {
    throw unavailable();
  }
  const parsed = eventSchema.safeParse(payload);
  if (!parsed.success) {
    throw unavailable();
  }
  const event = parsed.data;
  if (
    event.payload.project.id !== input.plan.target.projectId ||
    event.payload.team.id !== input.plan.target.teamId ||
    event.payload.deployment.meta.githubCommitRef !== input.plan.source.operationBranch ||
    event.payload.deployment.meta.githubCommitSha !== input.plan.source.reviewedSourceSha
  ) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Missing optional metadata is a deliberate unavailable result, never permission to execute.
    return undefined;
  }
  return centralNativeDeploymentReceiptSchema.parse({
    eventId: event.id,
    eventType: event.type,
    bodySha256: createHash("sha256").update(input.raw).digest("hex"),
    projectId: event.payload.project.id,
    teamId: event.payload.team.id,
    providerDeploymentId: event.payload.deployment.id,
    immutableOrigin: `https://${event.payload.deployment.url}`,
  });
};
export const centralNativeDeploymentStateSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("empty") }),
  z.strictObject({
    status: z.literal("accepted"),
    providerDeploymentId: id,
    immutableOrigin: origin,
    events: z.array(centralNativeDeploymentReceiptSchema).min(1).max(2),
  }),
  z.strictObject({
    status: z.literal("conflict"),
    providerDeploymentIds: z.array(id).min(1).max(2),
  }),
]);
export type CentralNativeDeploymentState = z.infer<typeof centralNativeDeploymentStateSchema>;
/** First native identity is immutable. Conflicts remain visible; no latest/ready/SHA or alias selection exists. */
export const retainCentralNativeDeploymentReceipt = (
  input: CentralNativeDeploymentState,
  raw: CentralNativeDeploymentReceipt,
): CentralNativeDeploymentState => {
  const state = centralNativeDeploymentStateSchema.parse(input);
  const receipt = centralNativeDeploymentReceiptSchema.parse(raw);
  if (state.status === "conflict") {
    return state;
  }
  if (state.status === "empty") {
    return {
      status: "accepted",
      providerDeploymentId: receipt.providerDeploymentId,
      immutableOrigin: receipt.immutableOrigin,
      events: [receipt],
    };
  }
  if (
    state.providerDeploymentId !== receipt.providerDeploymentId ||
    state.immutableOrigin !== receipt.immutableOrigin ||
    state.events.some(
      (event) => event.eventId === receipt.eventId && event.bodySha256 !== receipt.bodySha256,
    )
  ) {
    return {
      status: "conflict",
      providerDeploymentIds: [
        ...new Set([state.providerDeploymentId, receipt.providerDeploymentId]),
      ],
    };
  }
  if (state.events.some((event) => event.eventType === receipt.eventType)) {
    return state;
  }
  return { ...state, events: [...state.events, receipt] };
};
