import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { MessageStreamEvent } from "eve/client";

import {
  createPrivateOperatorApprovalCapture,
  readPrivateOperatorApproval,
} from "./private-operator-approval-observation";
import type {
  PrivateOperatorApprovalCapture,
  PrivateOperatorApprovalObservation,
} from "./private-operator-approval-observation";
import { privateNativeTargetApprovalObservationSchema } from "./private-native-target-approval";
import type { PrivateNativeTargetApprovalObservationPort } from "./private-native-target-approval";
import type { PrivateHistoryObservation } from "./same-origin-http";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
} from "../provisioning/native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyPlan } from "../provisioning/native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyResourceApprovalPlanSchema } from "../provisioning/native-target-auth-only-resource-plan-schema";
import { nativeTargetAuthOnlyApprovalSchema } from "../provisioning/native-target-auth-only-dispatch";
import type { NativeTargetAuthOnlyApproval } from "../provisioning/native-target-auth-only-dispatch";
import type { NativeTargetCurrentOwner } from "../provisioning/native-target-onboarding-store";

const digestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const terminalSchema = nativeTargetAuthOnlyApprovalSchema.pick({
  requestId: true,
  callId: true,
  responderPrincipalId: true,
  outcome: true,
  observedAt: true,
});
const unavailable = () => new Error("Auth-only resource approval is unavailable.");
export const nativeTargetAuthOnlyResourceApprovalAction =
  "native-target-auth-only-resources" as const;
export const nativeTargetAuthOnlyResourceApprovalTool =
  "prepare-app-native-target-auth-only-resources" as const;

/** The private tool echoes this retained non-secret intent; it never supplies approval or credentials. */
export const nativeTargetAuthOnlyResourcePreparationInputSchema = z.strictObject({
  appId: nativeTargetAuthOnlyPlanSchema.shape.appId,
  operationRef: z.uuid(),
  planDigest: digestSchema,
  resourcePlanDigest: digestSchema,
  resourcePlan: nativeTargetAuthOnlyResourceApprovalPlanSchema,
});
export type NativeTargetAuthOnlyResourcePreparationInput = z.infer<
  typeof nativeTargetAuthOnlyResourcePreparationInputSchema
>;

/** Read the original authenticated settlement for the exact retained resource operation, including on retry. */
export const readPrivateNativeTargetAuthOnlyResourceApproval = async (input: {
  owner: NativeTargetCurrentOwner;
  historyOwner: OperatorOwnerContext;
  plan: NativeTargetAuthOnlyPlan;
  operationRef: string;
  resourcePlanBytes: Buffer;
  resourcePlanDigest: string;
  /** Original durable terminal proof, never the retry invocation's call ID. Still verified against history. */
  retainedApproval?: NativeTargetAuthOnlyApproval;
  observation?: PrivateNativeTargetApprovalObservationPort;
  readHistory: (
    startIndex: number,
    onEvent: (event: MessageStreamEvent) => void,
  ) => Promise<PrivateHistoryObservation>;
  /** Re-read current canonical ownership and this exact retained operation before and after history. */
  assertOwner: () => Promise<void>;
}): Promise<NativeTargetAuthOnlyApproval | null> => {
  const owner = structuredClone(input.owner);
  const historyOwner = operatorOwnerContextSchema.parse(input.historyOwner);
  const plan = nativeTargetAuthOnlyPlanSchema.parse(input.plan);
  const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
  const resourceBytes = Buffer.from(input.resourcePlanBytes);
  const resourcePlanDigest = digestSchema.parse(input.resourcePlanDigest);
  if (createHash("sha256").update(resourceBytes).digest("hex") !== resourcePlanDigest) {
    throw unavailable();
  }
  const resourceJson: unknown = JSON.parse(resourceBytes.toString("utf-8"));
  const resource = nativeTargetAuthOnlyResourceApprovalPlanSchema.parse(resourceJson);
  const operationRef = z.uuid().parse(input.operationRef);
  const effects = resource.effects.filter((effect) => effect.kind === "resources");
  const selectedOwner = {
    historyAuthority: historyOwner.authority,
    planAuthority: plan.origin.authority,
    historySessionId: historyOwner.sessionId,
    adapterSessionId: historyOwner.adapterSessionId,
    adapterGeneration: historyOwner.adapterGeneration,
    planSessionId: plan.origin.publicSessionId,
  };
  if (
    !isDeepStrictEqual(selectedOwner, {
      historyAuthority: owner.authority,
      planAuthority: owner.authority,
      historySessionId: owner.publicSessionId,
      adapterSessionId: owner.adapterSessionId,
      adapterGeneration: owner.adapterGeneration,
      planSessionId: owner.publicSessionId,
    })
  ) {
    throw unavailable();
  }
  const selectedResource = {
    planDigest: resource.authOnlyPlanDigest,
    appId: resource.target.appId,
    sessionId: resource.target.sessionId,
    branch: resource.target.branch,
    scopeType: resource.target.scopeType,
    scopeId: resource.target.scopeId,
    installationId: resource.target.installationId,
    resourceId: resource.authDatabase.resourceId,
    database: resource.authDatabase.database,
    hostname: resource.neon.endpoint,
    endpointId: resource.bootstrap.endpointId,
    installer: resource.resourcesInstaller.reference,
  };
  if (
    !isDeepStrictEqual(selectedResource, {
      planDigest,
      appId: plan.appId,
      sessionId: plan.origin.publicSessionId,
      branch: plan.branch,
      scopeType: "team",
      scopeId: plan.project.teamId,
      installationId: plan.project.installationId,
      resourceId: plan.authResource.resourceId,
      database: plan.authResource.database,
      hostname: plan.authResource.hostname,
      endpointId: plan.authResource.endpointId,
      installer: "neon-resource-bootstrap-v1",
    })
  ) {
    throw unavailable();
  }
  if (
    effects.length !== 1 ||
    effects[0]?.resourceId !== plan.authResource.resourceId ||
    resource.effects.filter((effect) => effect.id === effects[0]?.id).length !== 1
  ) {
    throw unavailable();
  }
  const expected = {
    appId: plan.appId,
    operationRef,
    planDigest,
    resourcePlanDigest,
    resourcePlan: resourceJson,
  };
  nativeTargetAuthOnlyResourcePreparationInputSchema.parse(expected);
  const retainedApproval =
    input.retainedApproval === undefined
      ? undefined
      : nativeTargetAuthOnlyApprovalSchema.parse(input.retainedApproval);
  if (
    retainedApproval !== undefined &&
    !isDeepStrictEqual(
      {
        planDigest: retainedApproval.planDigest,
        sourceDigest: retainedApproval.sourceDigest,
        publicSessionId: retainedApproval.publicSessionId,
        responderPrincipalId: retainedApproval.responderPrincipalId,
      },
      {
        planDigest,
        sourceDigest: resourcePlanDigest,
        publicSessionId: plan.origin.publicSessionId,
        responderPrincipalId: owner.authority.ownerUserId,
      },
    )
  ) {
    throw unavailable();
  }
  const saved =
    input.observation?.state === undefined
      ? undefined
      : privateNativeTargetApprovalObservationSchema.parse(input.observation.state);
  const save = input.observation?.save;
  const assertOwner = input.assertOwner;
  const readHistory = input.readHistory;
  const terminals = new Map<string, z.infer<typeof terminalSchema>>();
  await assertOwner();
  return await readPrivateOperatorApproval({
    owner: historyOwner,
    ...(save === undefined
      ? {}
      : {
          observation: {
            ...(saved === undefined ? {} : { state: saved.native }),
            save: async (native: PrivateOperatorApprovalObservation) => {
              await save(
                privateNativeTargetApprovalObservationSchema.parse({
                  version: 1,
                  native,
                  terminals: [...terminals.values()],
                }),
              );
            },
          },
        }),
    capture: (state?: PrivateOperatorApprovalCapture) => {
      const current = createPrivateOperatorApprovalCapture({
        request: {
          action: nativeTargetAuthOnlyResourceApprovalAction,
          planRef: operationRef,
          planDigest: resourcePlanDigest,
          idempotencyKey: plan.appId,
        },
        ownerUserId: owner.authority.ownerUserId,
        ...(retainedApproval === undefined ? {} : { callId: retainedApproval.callId }),
        ...(state === undefined ? {} : { state }),
      });
      for (const terminal of saved?.terminals ?? []) {
        const entry = current
          .snapshot()
          .entries.find((candidate) => candidate.requestId === terminal.requestId);
        if (entry !== undefined && entry.callId === terminal.callId) {
          terminals.set(terminal.requestId, terminalSchema.parse(terminal));
        }
      }
      const proofFor = (entry: PrivateOperatorApprovalCapture["entries"][number]) => {
        const terminal = terminals.get(entry.requestId);
        if (terminal === undefined) {
          throw unavailable();
        }
        if (
          terminal.callId !== entry.callId ||
          terminal.responderPrincipalId !== owner.authority.ownerUserId ||
          terminal.outcome !== (entry.cancelled ? "cancelled" : "approved")
        ) {
          throw unavailable();
        }
        const proof = nativeTargetAuthOnlyApprovalSchema.parse({
          ...terminal,
          planDigest,
          sourceDigest: resourcePlanDigest,
          publicSessionId: plan.origin.publicSessionId,
        });
        if (
          proof.outcome === "approved" &&
          retainedApproval !== undefined &&
          !isDeepStrictEqual(proof, retainedApproval)
        ) {
          throw unavailable();
        }
        return proof;
      };
      return {
        observe(event: MessageStreamEvent) {
          if (event.type === "input.requested") {
            for (const request of event.data.requests) {
              if (
                request.kind !== "tool-approval" ||
                request.action.toolName !== nativeTargetAuthOnlyResourceApprovalTool
              ) {
                continue;
              }
              if (
                nativeTargetAuthOnlyResourcePreparationInputSchema.safeParse(request.action.input)
                  .success &&
                isDeepStrictEqual(request.action.input, expected)
              ) {
                current.acceptRequest(request.requestId, request.action.callId);
              }
            }
          } else if (event.type === "approval.settled") {
            const entry = current
              .snapshot()
              .entries.find((candidate) => candidate.requestId === event.data.requestId);
            if (entry === undefined) {
              return;
            }
            current.settle(event);
            const outcome = event.data.outcome === "approved" ? "approved" : "cancelled";
            const previous = terminals.get(entry.requestId);
            if (
              previous === undefined ||
              (previous.outcome === "approved" && outcome === "cancelled")
            ) {
              terminals.set(
                entry.requestId,
                terminalSchema.parse({
                  requestId: entry.requestId,
                  callId: entry.callId,
                  responderPrincipalId: event.data.responderPrincipalId,
                  outcome,
                  observedAt: event.meta.at,
                }),
              );
            }
          }
        },
        read(): NativeTargetAuthOnlyApproval | null {
          const entries = current.snapshot().entries;
          const cancelled = entries.filter((entry) => entry.cancelled);
          if (cancelled.length > 1) {
            throw unavailable();
          }
          if (cancelled[0] !== undefined) {
            return proofFor(cancelled[0]);
          }
          const receipt = current.read();
          if (receipt === null) {
            if (retainedApproval !== undefined) {
              throw unavailable();
            }
            return null;
          }
          const entry = entries.find((candidate) => candidate.requestId === receipt.approvalId);
          if (entry === undefined) {
            throw unavailable();
          }
          return proofFor(entry);
        },
        snapshot: current.snapshot,
        proveComplete: current.proveComplete,
      };
    },
    readHistory,
    assertOwner,
  });
};
