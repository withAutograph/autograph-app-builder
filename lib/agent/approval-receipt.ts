import { continuityApprovalInputSchema } from "../eve/private-continuity-approval";
import { tenantExportApprovalInputSchema } from "../eve/private-export-approval";
import { z } from "zod";
import {
  nativeTargetOnboardingPlanSchema,
  nativeTargetOnboardingPlanDigest,
} from "../provisioning/native-target-onboarding-contract";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../provisioning/hosted-operator-contract";
import type { HostedOperatorPlan } from "../provisioning/hosted-operator-contract";
import type {
  DraftPullRequestProposal,
  ImmutableGitHubSourceReceipt,
} from "@/lib/repository/github-publication";
import type { ExistingDraftUpdateProposal } from "@/lib/repository/github-draft-update";
import type { ExistingDraftReconciliationProposal } from "@/lib/repository/github-draft-reconciliation";

export const gitObjectIdSchema = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u);
const digest = z.string().regex(/^[0-9a-f]{64}$/u);
const appId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u);

export const approvalReceiptSchema = z
  .strictObject({
    baseRef: z.string().regex(/^refs\/heads\/[A-Za-z0-9._/-]+$/u),
    baseSha: gitObjectIdSchema,
    format: z.literal("autograph-eve-approval-receipt-v2"),
    outcome: z.enum(["accept-appspec", "accept_change_set", "create-draft-pr", "update-draft-pr"]),
    phase: z.enum(["appspec", "change_set", "publication", "draft_update"]),
    repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    repositoryId: z.string().regex(/^\d+$/u),
    subjectDigest: digest,
  })
  .superRefine((receipt, context) => {
    let expectedOutcome = "create-draft-pr";
    if (receipt.phase === "appspec") {
      expectedOutcome = "accept-appspec";
    } else if (receipt.phase === "change_set") {
      expectedOutcome = "accept_change_set";
    } else if (receipt.phase === "draft_update") {
      expectedOutcome = "update-draft-pr";
    }
    if (receipt.outcome !== expectedOutcome) {
      context.addIssue({
        code: "custom",
        message: "Approval outcome does not match its phase.",
        path: ["outcome"],
      });
    }
  });

export type ApprovalReceipt = z.infer<typeof approvalReceiptSchema>;
export type ApprovalTarget = Pick<
  ApprovalReceipt,
  "repositoryId" | "repository" | "baseRef" | "baseSha"
>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseApprovalReceipt(value: unknown): ApprovalReceipt {
  return approvalReceiptSchema.parse(value);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function approvalTarget(receipt: ApprovalReceipt): ApprovalTarget {
  return {
    baseRef: receipt.baseRef,
    baseSha: receipt.baseSha,
    repository: receipt.repository,
    repositoryId: receipt.repositoryId,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function approvalTargetFromGitHubSource(
  source: ImmutableGitHubSourceReceipt,
): ApprovalTarget {
  return {
    baseRef: source.resolvedRef,
    baseSha: source.resolvedSha,
    repository: `${source.repository.owner}/${source.repository.name}`,
    repositoryId: source.repository.repositoryId,
  };
}

export const approvalTargetFromDraftProposal = (
  proposal: Pick<
    DraftPullRequestProposal,
    "baseBranch" | "baseSha" | "owner" | "name" | "repositoryId"
  >,
): ApprovalTarget => ({
  baseRef: `refs/heads/${proposal.baseBranch}`,
  baseSha: proposal.baseSha,
  repository: `${proposal.owner}/${proposal.name}`,
  repositoryId: proposal.repositoryId,
});

type DraftHeadApprovalSubject = Pick<
  ExistingDraftUpdateProposal,
  "branchName" | "expectedHeadSha" | "name" | "owner" | "repositoryId"
>;

const approvalTargetFromDraftHead = (proposal: DraftHeadApprovalSubject): ApprovalTarget => ({
  baseRef: `refs/heads/${proposal.branchName}`,
  baseSha: proposal.expectedHeadSha,
  repository: `${proposal.owner}/${proposal.name}`,
  repositoryId: proposal.repositoryId,
});

export const approvalTargetFromExistingDraftUpdate: (
  proposal: ExistingDraftUpdateProposal,
) => ApprovalTarget = approvalTargetFromDraftHead;

export const approvalTargetFromExistingDraftReconciliation: (
  proposal: Pick<
    ExistingDraftReconciliationProposal,
    "branchName" | "expectedHeadSha" | "name" | "owner" | "repositoryId"
  >,
) => ApprovalTarget = approvalTargetFromDraftHead;

const utcExpiryFormatter = new Intl.DateTimeFormat("en", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "UTC",
});
const formatUtcExpiry = (value: string) => `${utcExpiryFormatter.format(new Date(value))} UTC`;

/** Give Builder the exact update subject; the model must not infer it from the PR base. */
export const approvalReceiptForExistingDraftUpdate = (
  proposal: DraftHeadApprovalSubject & { digest: string },
): ApprovalReceipt =>
  approvalReceiptSchema.parse({
    ...approvalTargetFromDraftHead(proposal),
    format: "autograph-eve-approval-receipt-v2",
    outcome: "update-draft-pr",
    phase: "draft_update",
    subjectDigest: proposal.digest,
  });

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function assertApprovalReceipt(input: {
  actual: ApprovalReceipt;
  phase: ApprovalReceipt["phase"];
  target: ApprovalTarget;
  subjectDigest: string;
}): ApprovalReceipt {
  const actual = parseApprovalReceipt(input.actual);
  let expectedOutcome = "create-draft-pr";
  if (input.phase === "appspec") {
    expectedOutcome = "accept-appspec";
  } else if (input.phase === "change_set") {
    expectedOutcome = "accept_change_set";
  } else if (input.phase === "draft_update") {
    expectedOutcome = "update-draft-pr";
  }
  const fields: readonly (readonly [string, string, string])[] = [
    ["phase", actual.phase, input.phase],
    ["outcome", actual.outcome, expectedOutcome],
    ["repository ID", actual.repositoryId, input.target.repositoryId],
    ["repository", actual.repository, input.target.repository],
    ["base ref", actual.baseRef, input.target.baseRef],
    ["base commit", actual.baseSha, input.target.baseSha],
    ["proposal digest", actual.subjectDigest, input.subjectDigest],
  ];
  const mismatches = fields
    .filter(([, actualValue, expectedValue]) => actualValue !== expectedValue)
    .map(([field]) => field);
  if (mismatches.length > 0) {
    const recovery =
      input.phase === "draft_update"
        ? `Draft updates authorize the existing PR head ${input.target.baseRef} at ${input.target.baseSha}, not the PR's base branch. Use the approvalReceipt returned by the current sealed draft proposal and request approval again.`
        : "Request approval for the current sealed proposal and its observed base commit, then retry publication.";
    throw new Error(
      `The approval receipt does not match the exact subject: ${mismatches.join(", ")}. ${recovery}`,
    );
  }
  return actual;
}

const isDraftPullRequestTool = (toolName?: string) =>
  toolName === "publish_github_draft_pr" || toolName === "publish-github-draft-pr";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function publicReceiptDescription(receipt: unknown, toolName?: string): string | undefined {
  const parsed = approvalReceiptSchema.safeParse(receipt);
  let expectedPhase: ApprovalReceipt["phase"] | undefined;
  if (toolName === "accept_app_spec") {
    expectedPhase = "appspec";
  } else if (toolName === "accept_change_set") {
    expectedPhase = "change_set";
  } else if (isDraftPullRequestTool(toolName)) {
    expectedPhase = "publication";
  } else if (toolName === "update_github_draft_pr" || toolName === "reconcile_github_draft_pr") {
    expectedPhase = "draft_update";
  }
  if (!parsed.success || (expectedPhase !== undefined && parsed.data.phase !== expectedPhase)) {
    return undefined;
  }
  if (isDraftPullRequestTool(toolName)) {
    const baseBranch = parsed.data.baseRef.replace(/^refs\/heads\//u, "");
    return `Publish the reviewed changes to a draft pull request in ${parsed.data.repository} on ${baseBranch}. It will remain a draft; this will not merge or deploy it.`;
  }
  if (toolName === "update_github_draft_pr" || toolName === "reconcile_github_draft_pr") {
    return `Update the reviewed changes in the existing draft pull request in ${parsed.data.repository}. It will remain a draft; this will not merge or deploy it.`;
  }
  return undefined;
}

const resourceEffectSummary = (
  plan: HostedOperatorPlan,
  effect: HostedOperatorPlan["effects"][number],
) => {
  if (plan.action === "cleanup")
    return "Remove the app-owned Preview resources included in this cleanup plan.";
  if (effect.resourceId === plan.authDatabase.resourceId) {
    return /never recreate or rotate shared auth/iu.test(effect.description)
      ? "Verify the existing shared sign-in resources and access; do not recreate or rotate shared Auth."
      : "Prepare or verify the approved shared sign-in database and access roles.";
  }
  return effect.resourceId === plan.appDatabase.resourceId
    ? "Prepare or verify the app's Preview database and access roles."
    : "Prepare or verify an approved Preview data resource.";
};
const installEffectSummary = (effect: HostedOperatorPlan["effects"][number]) => {
  if (effect.id === "auth-schema") {
    return /read-only/iu.test(effect.description)
      ? "Check the existing sign-in schema without migrating or recreating it."
      : "Install or migrate the approved shared sign-in schema.";
  }
  return effect.id === "app-install"
    ? "Install and verify the app's approved Preview release."
    : "Install or update the approved Preview data structures.";
};
const effectSummaryByKind = {
  resources: (plan: HostedOperatorPlan, effect: HostedOperatorPlan["effects"][number]) =>
    resourceEffectSummary(plan, effect),
  install: (_plan: HostedOperatorPlan, effect: HostedOperatorPlan["effects"][number]) =>
    installEffectSummary(effect),
  "gateway-bindings": () => "Connect the app's Preview environment to the shared sign-in service.",
  "gateway-delivery": () => "Update the shared sign-in service used by Preview.",
  access: (plan: HostedOperatorPlan) =>
    plan.action === "cleanup"
      ? "Revoke the app access created by this setup."
      : "Grant the app's approved Preview access.",
  "auth-membership": (plan: HostedOperatorPlan) =>
    plan.action === "cleanup"
      ? "Remove the organization memberships created by this setup."
      : "Create the planned organization and add its approved members.",
  "auth-signup-policy": (plan: HostedOperatorPlan) =>
    plan.action === "cleanup"
      ? "Remove the sign-up policy created by this setup."
      : "Apply the approved sign-up eligibility and app roles.",
  "normal-accounts": (plan: HostedOperatorPlan) =>
    plan.action === "cleanup"
      ? "Remove the app-owner access created by this setup."
      : "Create or update the approved app-owner access.",
  bindings: (plan: HostedOperatorPlan) =>
    plan.action === "cleanup"
      ? "Remove service connections created by this setup."
      : "Connect the app to its approved Preview services.",
  delivery: (plan: HostedOperatorPlan) =>
    plan.action === "cleanup"
      ? "Remove the app's Preview delivery."
      : "Publish the app's Preview delivery.",
  revoke: () => "Revoke access created by this setup.",
  "remove-bindings": () => "Remove service connections created by this setup.",
  retire: () => "Retire the app-owned Preview resource; shared Auth resources may be retained.",
} satisfies Record<
  HostedOperatorPlan["effects"][number]["kind"],
  (plan: HostedOperatorPlan, effect: HostedOperatorPlan["effects"][number]) => string
>;
const planHasEffect = (
  plan: HostedOperatorPlan,
  kind: HostedOperatorPlan["effects"][number]["kind"],
) => plan.effects.some((effect) => effect.kind === kind);
const operatorEffectSummaries = (plan: HostedOperatorPlan) => {
  const summaries = new Set<string>();
  for (const effect of plan.effects) {
    if (
      effect.kind === "access" ||
      effect.kind === "auth-membership" ||
      effect.kind === "auth-signup-policy"
    )
      continue;
    summaries.add(effectSummaryByKind[effect.kind](plan, effect));
  }
  return [...summaries];
};
const signupApprovalDescription = (plan: HostedOperatorPlan) => {
  const signupPolicy = plan.authSignupPolicy;
  if (signupPolicy === undefined || !planHasEffect(plan, "auth-signup-policy")) return "";
  return plan.action === "cleanup"
    ? `Sign-up access:\n- Remove sign-up access for ${signupPolicy.eligibility === "public" ? "anyone" : "approved email addresses only"}, including its ${signupPolicy.membershipRole} membership and app roles: ${signupPolicy.appRoles.join(", ")}.`
    : `Sign-up access:\n- Eligibility: ${signupPolicy.eligibility === "public" ? "anyone" : "approved email addresses only"}.\n- New members receive the ${signupPolicy.membershipRole} membership and these app roles: ${signupPolicy.appRoles.join(", ")}.`;
};
const operatorActorLookups = (plan: HostedOperatorPlan) => {
  const program = plan.normalActorProgram;
  const actorByKey = new Map(program?.actors.map((actor) => [actor.actorKey, actor] as const));
  const organizationById = new Map(
    (program?.organizations ?? []).map(
      (organization) => [organization.organizationId, organization.name] as const,
    ),
  );
  return { actorByKey, organizationById };
};
const operatorMembershipNames = (plan: HostedOperatorPlan) => {
  if (!planHasEffect(plan, "auth-membership")) return [];
  const membership = plan.authMembership;
  if (membership === undefined)
    return plan.normalActorProgram?.organizations.map((organization) => organization.name) ?? [];
  return membership.kind === "create-owned-organization"
    ? [membership.name]
    : membership.organizations.map((organization) => organization.name);
};
const operatorOwnedOrganizations = (plan: HostedOperatorPlan) => {
  const membership = plan.authMembership;
  if (!planHasEffect(plan, "auth-membership") || membership === undefined) return [];
  return membership.kind === "create-owned-organization" ? [membership] : membership.organizations;
};
const operatorMembershipSummary = (plan: HostedOperatorPlan) => {
  const program = plan.normalActorProgram;
  const membershipNames = operatorMembershipNames(plan);
  const { actorByKey, organizationById } = operatorActorLookups(plan);
  const memberLines = planHasEffect(plan, "auth-membership")
    ? (program?.memberships ?? []).map((grant) => {
        const actor = actorByKey.get(grant.actorKey);
        const person =
          actor === undefined ? "the approved member" : `${actor.name} (${actor.email})`;
        const organization =
          organizationById.get(grant.organizationId) ?? "the approved organization";
        return plan.action === "cleanup"
          ? `Remove the ${grant.role} membership for ${person} in ${organization}.`
          : `Give ${person} the ${grant.role} membership in ${organization}.`;
      })
    : [];
  const ownedOrganizations = operatorOwnedOrganizations(plan);
  const organizationReferenceLines = ownedOrganizations.map(
    (organization) =>
      `${organization.actorId} in ${organization.organizationId}: owner membership for ${organization.name}.`,
  );
  if (memberLines.length === 0 && membershipNames.length > 0) {
    memberLines.push(
      `${plan.action === "cleanup" ? "Remove" : "Create"} the approved organization and its owner membership.`,
    );
  }
  const membershipSummary =
    memberLines.length === 0
      ? ""
      : `Organization access:\n${memberLines.map((line) => `- ${line}`).join("\n")}`;
  const organizationReferenceSummary =
    organizationReferenceLines.length === 0
      ? ""
      : `Organization details (provider identity references):\n${organizationReferenceLines.map((line) => `- ${plan.action === "cleanup" ? "Remove" : "Create"} ${line}`).join("\n")}`;
  return { membershipSummary, organizationReferenceSummary };
};
const operatorAccessEffect = (plan: HostedOperatorPlan) => {
  if (planHasEffect(plan, "revoke")) return "Revoke";
  return planHasEffect(plan, "access") ? "Grant" : undefined;
};
const operatorAccessSummary = (
  appAccessLines: string[],
  unresolvedAccessLines: string[],
  accessEffect: ReturnType<typeof operatorAccessEffect>,
  accessDescription: string,
) => {
  if (appAccessLines.length > 0)
    return `${accessDescription}\n${appAccessLines.map((line) => `- ${line}`).join("\n")}`;
  if (unresolvedAccessLines.length > 0)
    return "See Access details for each app user and its roles.";
  if (accessEffect === undefined) return "No app-user access changes are included in this plan.";
  return accessEffect === "Revoke"
    ? "No app-user access is included in the revoke effect."
    : "No app-user access is included in the grant effect.";
};
const operatorAccessDescriptions = (plan: HostedOperatorPlan) => {
  const program = plan.normalActorProgram;
  const { actorByKey, organizationById } = operatorActorLookups(plan);
  const appAccessLines = (program?.appAccess ?? []).map((grant) => {
    const actor = actorByKey.get(grant.actorKey);
    const person = actor === undefined ? "the approved user" : `${actor.name} (${actor.email})`;
    const organization = organizationById.get(grant.organizationId) ?? "the approved organization";
    return `${person} in ${organization}: ${grant.roles.join(", ")}.`;
  });
  const unresolvedAccessLines = plan.access.map(
    (grant) =>
      `Recipient ${grant.actorId} in organization ${grant.organizationId}: ${grant.roles.join(", ")}.`,
  );
  const accessEffect = operatorAccessEffect(plan);
  const accessDescription =
    accessEffect === undefined
      ? "Approved app-role scope by recipient and organization (not changed by this plan):"
      : `${accessEffect} these app roles by recipient and organization:`;
  const accessSummary = operatorAccessSummary(
    appAccessLines,
    unresolvedAccessLines,
    accessEffect,
    accessDescription,
  );
  const unresolvedAccessVerb =
    accessEffect === undefined ? "Approved scope (not changed by this plan):" : `${accessEffect}:`;
  const unresolvedAccessSummary =
    unresolvedAccessLines.length === 0
      ? ""
      : `Access details (provider identity references):\n${unresolvedAccessLines.map((line) => `- ${unresolvedAccessVerb} ${line}`).join("\n")}`;
  return { accessSummary, unresolvedAccessSummary };
};
const operatorAccountSummary = (plan: HostedOperatorPlan) => {
  const program = plan.normalActorProgram;
  const newAccountActors =
    plan.action === "prepare" && planHasEffect(plan, "normal-accounts")
      ? (program?.actors.filter((actor) => actor.account === "create-email-password") ?? [])
      : [];
  const accountSummary =
    newAccountActors.length > 0
      ? ` Create sign-in accounts for ${newAccountActors.map((actor) => `${actor.name} (${actor.email})`).join(", ")}.`
      : "";
  return accountSummary;
};

const operatorRetentionSummary = (plan: HostedOperatorPlan) => {
  const retentionDate = formatUtcExpiry(plan.retention.expiresAt);
  const retentionSummary =
    plan.action === "cleanup"
      ? `${plan.retention.policy} (scheduled expiry ${retentionDate}). Cleanup removes only the app-owned resources included in this plan; shared Auth may be retained.`
      : `${plan.retention.policy} (expires ${retentionDate}). Resources may continue to incur provider charges until removed.`;
  return retentionSummary;
};

const operatorApprovalDescription = (record: Record<string, unknown>, toolName: string) => {
  const parsed = hostedOperatorPlanSchema.safeParse(record.plan);
  if (
    !parsed.success ||
    record.planDigest !== operatorPlanDigest(parsed.data) ||
    parsed.data.action !== (toolName === "cleanup-app-hosted-runtime" ? "cleanup" : "prepare") ||
    record.environment !== "preview" ||
    parsed.data.selection.appId !== record.appId ||
    parsed.data.selection.projectId !== record.projectId ||
    parsed.data.selection.branch !== record.branch
  ) {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Optional descriptions explicitly return no public approval.
    return undefined;
  }
  const plan = parsed.data;
  const effectSummaries = operatorEffectSummaries(plan);
  const signupApproval = signupApprovalDescription(plan);
  const host = plan.hostProtection;
  const hostApproval =
    host === undefined
      ? ""
      : "Deployment access:\n- Uses the team's existing Preview deployment protection settings; those settings will not change.";
  const replacement = plan.appDeliveryReplacement?.predecessor;
  const replacementApproval =
    replacement === undefined
      ? ""
      : "Deployment usage:\n- A new Preview delivery will replace an existing ready delivery. Both may incur deployment usage until replacement finishes.";
  const { membershipSummary, organizationReferenceSummary } = operatorMembershipSummary(plan);
  const { accessSummary, unresolvedAccessSummary } = operatorAccessDescriptions(plan);
  const accountSummary = operatorAccountSummary(plan);
  const costOwnerReferenceSummary = `Billing details (provider owner reference):\n- ${plan.cost.owner}`;
  const resourceSentence =
    plan.action === "cleanup"
      ? "Clean up this app's Preview resources and revoke access created for them. Shared Auth resources may remain under the approved retention policy."
      : "Prepare this app's Preview resources and required service connections.";
  const costOwner = "the owner recorded in this approved plan";
  const retentionSummary = operatorRetentionSummary(plan);
  return [
    resourceSentence,
    "Production will not be deployed or activated.",
    ...(effectSummaries.length > 0
      ? [`What will happen:\n${effectSummaries.map((effect) => `- ${effect}`).join("\n")}`]
      : []),
    ...(membershipSummary ? [membershipSummary] : []),
    `Access and cost:\n- ${accessSummary}${accountSummary}\n- ${plan.cost.description} Billing responsibility follows ${costOwner}. Check the provider's billing page for amounts.`,
    ...(unresolvedAccessSummary ? [unresolvedAccessSummary] : []),
    ...(organizationReferenceSummary ? [organizationReferenceSummary] : []),
    costOwnerReferenceSummary,
    ...(signupApproval ? [signupApproval] : []),
    ...(hostApproval ? [hostApproval] : []),
    ...(replacementApproval ? [replacementApproval] : []),
    `Retention:\n- ${retentionSummary}`,
  ]
    .filter(Boolean)
    .join("\n\n");
};

const continuityApprovalDescription = (input: unknown): string | undefined => {
  const parsed = continuityApprovalInputSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const actorOrganizationReferences = parsed.data.plan.actors.map(
    (actor) => `${actor.actorId} in ${actor.organizationId}`,
  );
  return [
    `Run the app's existing browser checks against its Preview environment. The checks may perform the actions written into the app and restart only this app's process.`,
    "What will happen:\n- Start the app's Preview environment and temporarily publish its test connection to the shared service.\n- Close the app environment and remove the temporary connection when the checks finish. The shared service may retain the target until its normal refresh or expiry.",
    `Test actor and organization references (provider identity references):\n${actorOrganizationReferences.map((reference) => `- ${reference}`).join("\n")}`,
    "This does not change the app's main project or prove behavior after a later deployment.",
  ].join("\n\n");
};
const nativeTargetApprovalDescription = (input: unknown): string | undefined => {
  const parsed = z
    .strictObject({
      appId,
      operationRef: z.uuid(),
      planDigest: digest,
      plan: nativeTargetOnboardingPlanSchema,
    })
    .safeParse(input);
  if (
    !parsed.success ||
    parsed.data.appId !== parsed.data.plan.appId ||
    nativeTargetOnboardingPlanDigest(parsed.data.plan) !== parsed.data.planDigest
  )
    return undefined;
  const { plan } = parsed.data;
  const conflict =
    plan.conflictPolicy === "stop-on-conflict"
      ? "Stop if the project name is already taken."
      : "Use a unique suffix only after the provider confirms a name conflict.";
  const retentionExpiry =
    plan.retention.expiresAt === undefined
      ? ""
      : ` (expires ${formatUtcExpiry(plan.retention.expiresAt)})`;
  return [
    `Create the Preview project ${plan.project.name} for app ${plan.appId}, then register its Preview branch.`,
    `Access and setup:\n- Require Vercel sign-in for deployments and enable this project's workload identity before registration.\n- ${conflict}\n- This reserves the app database name for a later, separately approved setup. No database or app-user access is created now.`,
    `Cost and retention:\n- ${plan.cost.description} Billing responsibility follows the current owner recorded in this plan. Check the provider's billing page for amounts.\n- ${plan.retention.policy}${retentionExpiry}.`,
    "This does not deploy the app or activate Production.",
  ].join("\n\n");
};
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function publicApprovalDescription(input: unknown, toolName?: string): string | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  if (toolName === "prepare-app-native-target") return nativeTargetApprovalDescription(record);
  if (toolName === "run-app-continuity-tests") return continuityApprovalDescription(record);
  if (toolName === "export-app-hosted-data") {
    const parsed = tenantExportApprovalInputSchema.safeParse(record);
    if (!parsed.success) return undefined;
    const plan = parsed.data.plan;
    return [
      `Export the selected customer's ${plan.scope.appId} data for private review. Builder will read the app's public tables in a read-only snapshot and keep the export and manifest private to you in this session. No external recipient or database changes are included. This may contain customer information; approve only if you need this export.`,
      `Customer reference (provider identity reference):\n- ${plan.scope.customerId}`,
    ].join("\n\n");
  }
  if (toolName === "prepare-app-hosted-runtime" || toolName === "cleanup-app-hosted-runtime") {
    return operatorApprovalDescription(record, toolName);
  }

  if (Object.hasOwn(record, "approvalReceipt")) {
    return publicReceiptDescription(record.approvalReceipt, toolName);
  }
  if (toolName === "accept_app_spec") {
    const parsed = z
      .strictObject({
        appId,
        artifactRevision: digest,
        eligibilityDigest: digest,
        format: z.literal("autograph-local-approval-subject-v1"),
        outcome: z.literal("accept-appspec"),
        phase: z.literal("appspec"),
        sourceSha: gitObjectIdSchema,
        sourceTree: gitObjectIdSchema,
        subjectDigest: digest,
        workspaceDigest: digest,
      })
      .safeParse({
        appId: record.appId,
        artifactRevision: record.expectedArtifactRevision,
        eligibilityDigest: record.expectedEligibilityDigest,
        format: "autograph-local-approval-subject-v1",
        outcome: "accept-appspec",
        phase: "appspec",
        sourceSha: record.expectedSourceSha,
        sourceTree: record.expectedSourceTree,
        subjectDigest: record.expectedArtifactDigest,
        workspaceDigest: record.expectedWorkspaceDigest,
      });
    return parsed.success
      ? `Accept the reviewed AppSpec for ${parsed.data.appId} and continue with its implementation plan.`
      : undefined;
  }
  if (toolName === "accept_change_set") {
    const changeSet =
      typeof record.changeSet === "object" &&
      record.changeSet !== null &&
      !Array.isArray(record.changeSet)
        ? (record.changeSet as Record<string, unknown>)
        : undefined;
    const parsed = z
      .strictObject({
        format: z.literal("autograph-local-approval-subject-v1"),
        outcome: z.literal("accept_change_set"),
        phase: z.literal("change_set"),
        subjectDigest: digest,
      })
      .safeParse({
        format: "autograph-local-approval-subject-v1",
        outcome: "accept_change_set",
        phase: "change_set",
        subjectDigest: changeSet?.digest,
      });
    return parsed.success
      ? "Accept the reviewed change set after its final source assessment. This records review in the Builder session; it does not publish or change an external repository."
      : undefined;
  }
  return undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function approvalRequestDecision(input: {
  phase: "appspec" | "change_set";
  toolName: "accept_app_spec" | "accept_change_set";
  toolInput: Record<string, unknown>;
  githubSource: ImmutableGitHubSourceReceipt | undefined;
  subjectDigest: string;
}): "user-approval" | { type: "denied"; reason: string } {
  const receipt = input.toolInput.approvalReceipt;
  if (input.githubSource === undefined) {
    if (
      Object.hasOwn(input.toolInput, "approvalReceipt") ||
      publicApprovalDescription(input.toolInput, input.toolName) === undefined
    ) {
      return {
        reason: "The local approval subject is missing or invalid.",
        type: "denied",
      };
    }
    return "user-approval";
  }
  try {
    assertApprovalReceipt({
      actual: approvalReceiptSchema.parse(receipt),
      phase: input.phase,
      subjectDigest: input.subjectDigest,
      target: approvalTargetFromGitHubSource(input.githubSource),
    });
    return "user-approval";
  } catch {
    return {
      reason: "The GitHub-bound approval receipt is missing, stale, or for the wrong phase.",
      type: "denied",
    };
  }
}
