import { z } from "zod";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import {
  nativeTargetOnboardingApprovalSchema,
  nativeTargetOnboardingPlanDigest,
} from "./native-target-onboarding-contract";
import {
  nativeTargetPlanRequestSchema,
  nativeTargetPreparationRequestSchema,
  nativeTargetOnboardingResultSchema,
} from "../agent/native-target-onboarding-runtime";

const id = z.string().min(1);
const common = { ownerContext: operatorOwnerContextSchema, adapterSessionId: id, callId: id };
/** Minimal authenticated native responder identity; excludes auth functions and forwarded attributes. */
export const nativeTargetApprovalResponderSchema = z.strictObject({
  authenticator: id,
  principalId: id,
  principalType: id,
  issuer: id.optional(),
  subject: id.optional(),
});
export const nativeTargetTransportRequestSchema = z
  .discriminatedUnion("action", [
    z.strictObject({
      ...common,
      action: z.literal("native-target-plan"),
      input: nativeTargetPlanRequestSchema,
      // Absence authorizes only reading an existing owner-scoped operation.
      selectedApp: z
        .strictObject({
          appId: nativeTargetPlanRequestSchema.shape.appId,
          appSpecDigest: z.string().regex(/^[a-f0-9]{64}$/u),
        })
        .optional(),
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-prepare"),
      input: nativeTargetPreparationRequestSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-approval-read"),
      input: nativeTargetPreparationRequestSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-approval-candidate"),
      input: nativeTargetPreparationRequestSchema,
      candidate: z.strictObject({
        requestId: id,
        callId: id,
        toolName: z.literal("prepare-app-native-target"),
        responder: nativeTargetApprovalResponderSchema,
      }),
    }),
  ])
  .superRefine((request, context) => {
    const matches = [request.adapterSessionId === request.ownerContext.adapterSessionId];
    if (request.action === "native-target-plan") {
      matches.push(
        request.selectedApp === undefined || request.selectedApp.appId === request.input.appId,
      );
    } else {
      matches.push(
        request.input.appId === request.input.plan.appId,
        request.input.planDigest === nativeTargetOnboardingPlanDigest(request.input.plan),
      );
    }
    if (request.action === "native-target-approval-candidate") {
      matches.push(
        request.candidate.callId === request.callId,
        request.candidate.responder.principalId === request.ownerContext.authority.ownerUserId,
        request.candidate.responder.principalType === "user",
      );
    }
    if (!matches.every(Boolean)) {
      context.addIssue({ code: "custom", message: "Native target request identities disagree." });
    }
  });
export type NativeTargetTransportRequest = z.infer<typeof nativeTargetTransportRequestSchema>;
export const nativeTargetTerminalApprovalResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({
    status: z.literal("approved"),
    proof: nativeTargetOnboardingApprovalSchema.extend({ outcome: z.literal("approved") }),
  }),
  z.strictObject({
    status: z.literal("cancelled"),
    proof: nativeTargetOnboardingApprovalSchema.extend({ outcome: z.literal("cancelled") }),
  }),
]);
export const nativeTargetApprovalCandidateResultSchema = z.strictObject({
  status: z.literal("allowed"),
});
export const nativeTargetTransportResponseSchemas = {
  "native-target-plan": nativeTargetOnboardingResultSchema,
  "native-target-prepare": nativeTargetOnboardingResultSchema,
  "native-target-approval-read": nativeTargetTerminalApprovalResultSchema,
  "native-target-approval-candidate": nativeTargetApprovalCandidateResultSchema,
} as const;

export type NativeTargetTransportResponse =
  | z.infer<typeof nativeTargetOnboardingResultSchema>
  | z.infer<typeof nativeTargetTerminalApprovalResultSchema>
  | z.infer<typeof nativeTargetApprovalCandidateResultSchema>;
