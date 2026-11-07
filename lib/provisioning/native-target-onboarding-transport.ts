import { z } from "zod";
import {
  operatorDeploymentCandidateSchema,
  operatorOwnerContextSchema,
} from "./hosted-operator-contract";
import {
  nativeTargetOnboardingApprovalSchema,
  nativeTargetOnboardingPlanDigest,
} from "./native-target-onboarding-contract";
import {
  nativeTargetPlanRequestSchema,
  nativeTargetPreparationRequestSchema,
  nativeTargetOnboardingResultSchema,
  nativeTargetAuthOnlyPlanRequestSchema as authOnlyInputSchema,
  nativeTargetAuthOnlyPlanResultSchema,
} from "../agent/native-target-onboarding-input-schema";
import {
  nativeTargetAuthOnlyPlanSchema,
  nativeTargetAuthOnlyPlanDigest,
} from "./native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyEntryApprovalInputSchema } from "./native-target-auth-only-entry-plan-store";
import { nativeTargetAuthOnlyDeliveryPreparationInputSchema } from "../eve/private-native-target-auth-only-delivery-approval";
import {
  nativeTargetAuthOnlyFinalRoutingApprovalInputSchema,
  nativeTargetAuthOnlyFinalRoutingPlanInputSchema,
} from "../eve/private-native-target-auth-only-final-routing-approval";
import { nativeTargetAuthOnlyResourcePreparationInputSchema } from "../eve/private-native-target-auth-only-resource-approval";

const id = z.string().min(1);
const common = { adapterSessionId: id, callId: id, ownerContext: operatorOwnerContextSchema };
export const nativeTargetAuthOnlyPlanRequestSchema = z
  .strictObject({
    ...common,
    action: z.literal("native-target-auth-only-plan"),
    input: authOnlyInputSchema,
    selectedApp: z.strictObject({
      appId: nativeTargetAuthOnlyPlanSchema.shape.appId,
      appSpecDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    }),
  })
  .superRefine((request, context) => {
    if (
      request.adapterSessionId !== request.ownerContext.adapterSessionId ||
      request.selectedApp.appId !== request.input.appId
    ) {
      context.addIssue({ code: "custom", message: "Auth-only plan identities disagree." });
    }
  });
export const nativeTargetAuthOnlyPlanResponseSchema = nativeTargetAuthOnlyPlanResultSchema.refine(
  (result) => result.planDigest === nativeTargetAuthOnlyPlanDigest(result.plan),
);
export const nativeTargetAuthOnlyPreparationRequestSchema = z
  .strictObject({
    appId: nativeTargetAuthOnlyPlanSchema.shape.appId,
    operationRef: z.string().min(1),
    plan: nativeTargetAuthOnlyPlanSchema,
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .superRefine((value, context) => {
    if (
      value.appId !== value.plan.appId ||
      value.operationRef !== value.planDigest ||
      nativeTargetAuthOnlyPlanDigest(value.plan) !== value.planDigest
    ) {
      context.addIssue({
        code: "custom",
        message: "Auth-only preparation identity or plan digest changed.",
      });
    }
  });
export const nativeTargetAuthOnlyDispatchResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ projectId: id, status: z.literal("created") }),
  z.strictObject({ projectId: id.optional(), status: z.literal("unknown") }),
  z.strictObject({
    reason: z.enum([
      "authorization_denied",
      "collision",
      "permission_denied",
      "provider_rejected",
      "rate_limited",
    ]),
    status: z.literal("rejected"),
  }),
]);
export const nativeTargetAuthOnlyResourceResultSchema = z.strictObject({
  authSchema: z.strictObject({
    artifactRef: id,
    planDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    targetDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  readiness: id,
  resourcePlanDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.literal("prepared"),
});
export const nativeTargetAuthOnlyEntryPlanInputSchema =
  nativeTargetAuthOnlyEntryApprovalInputSchema.pick({
    appId: true,
    deliveryOperationRef: true,
    deliveryPlanDigest: true,
    effect: true,
  });
export const nativeTargetAuthOnlyEntryResultSchema = nativeTargetAuthOnlyEntryApprovalInputSchema
  .pick({
    childOperationRef: true,
    childPlanDigest: true,
    effect: true,
  })
  .extend({ status: z.literal("prepared") });
export type NativeTargetAuthOnlyEntryPlanInput = z.infer<
  typeof nativeTargetAuthOnlyEntryPlanInputSchema
>;
export type NativeTargetAuthOnlyEntryResult = z.infer<typeof nativeTargetAuthOnlyEntryResultSchema>;
export const nativeTargetAuthOnlyDeliveryPlanInputSchema =
  nativeTargetAuthOnlyDeliveryPreparationInputSchema.pick({
    appId: true,
    operationRef: true,
    planDigest: true,
    resourcePlanDigest: true,
  });
export const nativeTargetAuthOnlyFinalRoutingResultSchema = z.strictObject({
  app: operatorDeploymentCandidateSchema.extend({ readyState: z.literal("READY") }),
  deliveryPlanDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  gateway: operatorDeploymentCandidateSchema.extend({ readyState: z.literal("READY") }),
  projectionDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  status: z.literal("prepared"),
});
export const nativeTargetAuthOnlyDeliveryResultSchema = z.discriminatedUnion("status", [
  z
    .strictObject({
      app: operatorDeploymentCandidateSchema.extend({ readyState: z.literal("READY") }),
      deliveryPlanDigest: z.string().regex(/^[a-f0-9]{64}$/u),
      finalRoutingPlan: nativeTargetAuthOnlyFinalRoutingApprovalInputSchema.optional(),
      gateway: operatorDeploymentCandidateSchema.extend({ readyState: z.literal("READY") }),
      projectionDigest: z
        .string()
        .regex(/^[a-f0-9]{64}$/u)
        .optional(),
      status: z.literal("prepared"),
    })
    .refine(
      (result) =>
        (result.finalRoutingPlan === undefined) === (result.projectionDigest === undefined),
      {
        message: "Final routing identity and projection receipt must be returned together.",
      },
    ),
  z.strictObject({
    authIdentityLink: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    }),
    authIdentityLinkExpiresAt: z.iso.datetime({ offset: true }),
    deliveryPlanDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    status: z.literal("pending-owner"),
  }),
  z.strictObject({
    app: operatorDeploymentCandidateSchema.extend({ readyState: z.literal("READY") }),
    deliveryPlanDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    finalRoutingPlan: nativeTargetAuthOnlyFinalRoutingApprovalInputSchema,
    gateway: operatorDeploymentCandidateSchema.extend({ readyState: z.literal("READY") }),
    status: z.literal("routing-required"),
  }),
]);
export const nativeTargetAuthOnlyPrepareRequestSchema = z.strictObject({
  ...common,
  action: z.literal("native-target-auth-only-prepare"),
  input: nativeTargetAuthOnlyPreparationRequestSchema,
});
export type NativeTargetAuthOnlyPlanTransportRequest = z.infer<
  typeof nativeTargetAuthOnlyPlanRequestSchema
>;
export type NativeTargetAuthOnlyPlanResponse = z.infer<
  typeof nativeTargetAuthOnlyPlanResponseSchema
>;
/** Minimal authenticated native responder identity; excludes auth functions and forwarded attributes. */
export const nativeTargetApprovalResponderSchema = z.strictObject({
  authenticator: id,
  issuer: id.optional(),
  principalId: id,
  principalType: id,
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
      candidate: z.strictObject({
        requestId: id,
        callId: id,
        toolName: z.literal("prepare-app-native-target"),
        responder: nativeTargetApprovalResponderSchema,
      }),
      input: nativeTargetPreparationRequestSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-delivery-plan"),
      input: nativeTargetAuthOnlyDeliveryPlanInputSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-delivery-approval-read"),
      input: nativeTargetAuthOnlyDeliveryPreparationInputSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-delivery"),
      input: nativeTargetAuthOnlyDeliveryPreparationInputSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-entry-plan"),
      input: nativeTargetAuthOnlyEntryPlanInputSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-entry-approval-read"),
      input: nativeTargetAuthOnlyEntryApprovalInputSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-final-routing-plan"),
      input: nativeTargetAuthOnlyFinalRoutingPlanInputSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-final-routing-approval-read"),
      input: nativeTargetAuthOnlyFinalRoutingApprovalInputSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-final-routing"),
      input: nativeTargetAuthOnlyFinalRoutingApprovalInputSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-entry"),
      input: nativeTargetAuthOnlyEntryApprovalInputSchema,
    }),
    nativeTargetAuthOnlyPrepareRequestSchema,
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-approval-read"),
      input: nativeTargetAuthOnlyPreparationRequestSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-resource-approval-read"),
      input: nativeTargetAuthOnlyResourcePreparationInputSchema,
    }),
    z.strictObject({
      ...common,
      action: z.literal("native-target-auth-only-resources"),
      input: nativeTargetAuthOnlyResourcePreparationInputSchema,
    }),
  ])
  .superRefine((request, context) => {
    const matches = [request.adapterSessionId === request.ownerContext.adapterSessionId];
    if (request.action === "native-target-plan") {
      matches.push(
        request.selectedApp === undefined || request.selectedApp.appId === request.input.appId,
      );
    } else if (
      request.action === "native-target-auth-only-prepare" ||
      request.action === "native-target-auth-only-approval-read"
    ) {
      matches.push(request.input.appId === request.input.plan.appId);
    } else if (
      request.action === "native-target-auth-only-resource-approval-read" ||
      request.action === "native-target-auth-only-resources"
    ) {
      matches.push(request.input.resourcePlan.authOnlyPlanDigest === request.input.planDigest);
    } else if (
      request.action === "native-target-auth-only-delivery-approval-read" ||
      request.action === "native-target-auth-only-delivery"
    ) {
      matches.push(
        request.input.appId === request.input.deliveryPlan.target.appId,
        request.input.deliveryPlan.target.sessionId === request.ownerContext.sessionId,
        request.input.deliveryPlan.authOnlyPlanDigest === request.input.planDigest,
        request.input.deliveryPlan.resourcePlanDigest === request.input.resourcePlanDigest,
      );
    } else if (
      request.action === "native-target-approval-candidate" ||
      request.action === "native-target-approval-read" ||
      request.action === "native-target-prepare"
    ) {
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
export type NativeTargetRequest =
  | NativeTargetTransportRequest
  | NativeTargetAuthOnlyPlanTransportRequest;
export const nativeTargetTerminalApprovalResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("pending") }),
  z.strictObject({
    proof: nativeTargetOnboardingApprovalSchema.extend({ outcome: z.literal("approved") }),
    status: z.literal("approved"),
  }),
  z.strictObject({
    proof: nativeTargetOnboardingApprovalSchema.extend({ outcome: z.literal("cancelled") }),
    status: z.literal("cancelled"),
  }),
]);
export const nativeTargetApprovalCandidateResultSchema = z.strictObject({
  status: z.literal("allowed"),
});
export const nativeTargetTransportResponseSchemas = {
  "native-target-approval-candidate": nativeTargetApprovalCandidateResultSchema,
  "native-target-approval-read": nativeTargetTerminalApprovalResultSchema,
  "native-target-auth-only-approval-read": z.strictObject({
    status: z.enum(["approved", "pending"]),
  }),
  "native-target-auth-only-delivery": nativeTargetAuthOnlyDeliveryResultSchema,
  "native-target-auth-only-delivery-approval-read": z.strictObject({
    status: z.enum(["approved", "pending"]),
  }),
  "native-target-auth-only-delivery-plan": nativeTargetAuthOnlyDeliveryPreparationInputSchema,
  "native-target-auth-only-entry": nativeTargetAuthOnlyEntryResultSchema,
  "native-target-auth-only-entry-approval-read": z.strictObject({
    status: z.enum(["approved", "pending"]),
  }),
  "native-target-auth-only-entry-plan": nativeTargetAuthOnlyEntryApprovalInputSchema,
  "native-target-auth-only-final-routing": nativeTargetAuthOnlyFinalRoutingResultSchema,
  "native-target-auth-only-final-routing-approval-read": z.strictObject({
    status: z.enum(["approved", "pending"]),
  }),
  "native-target-auth-only-final-routing-plan": nativeTargetAuthOnlyFinalRoutingApprovalInputSchema,
  "native-target-auth-only-prepare": nativeTargetAuthOnlyDispatchResultSchema,
  "native-target-auth-only-resource-approval-read": z.strictObject({
    status: z.enum(["approved", "pending"]),
  }),
  "native-target-auth-only-resources": nativeTargetAuthOnlyResourceResultSchema,
  "native-target-plan": nativeTargetOnboardingResultSchema,
  "native-target-prepare": nativeTargetOnboardingResultSchema,
} as const;

export type NativeTargetTransportResponse =
  | z.infer<typeof nativeTargetOnboardingResultSchema>
  | z.infer<typeof nativeTargetTerminalApprovalResultSchema>
  | z.infer<typeof nativeTargetApprovalCandidateResultSchema>
  | z.infer<typeof nativeTargetAuthOnlyDispatchResultSchema>
  | { status: "approved" | "pending" }
  | z.infer<typeof nativeTargetAuthOnlyResourceResultSchema>
  | z.infer<typeof nativeTargetAuthOnlyDeliveryPreparationInputSchema>
  | z.infer<typeof nativeTargetAuthOnlyDeliveryResultSchema>
  | z.infer<typeof nativeTargetAuthOnlyEntryApprovalInputSchema>
  | z.infer<typeof nativeTargetAuthOnlyEntryResultSchema>
  | z.infer<typeof nativeTargetAuthOnlyFinalRoutingApprovalInputSchema>
  | z.infer<typeof nativeTargetAuthOnlyFinalRoutingResultSchema>;
