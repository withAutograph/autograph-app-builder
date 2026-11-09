import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { appAccessIntentSchema, resolveAppAccessIntent } from "../agent/app-access-intent";
import type { AppAccessIntent } from "../agent/app-access-intent";
import type { AppDescription } from "../repository/app-description";
import {
  repositoryProductionOperationRef,
  repositoryProductionSignupPathSchema,
} from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type {
  RepositoryProductionEffectContext,
  RepositoryProductionObservation,
} from "./repository-production-setup";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
export const repositoryProductionSignupPolicySchema = z.object({
  version: z.literal(1),
  policyId: z.uuid(),
  policyDigest: digest,
  workspaceId: z.string().min(1),
  resourceDigest: digest,
  appId: z.string().min(1),
  organizationId: z.string().min(1),
  origin: z.url(),
  appPath: repositoryProductionSignupPathSchema,
  eligibility: z.enum(["public", "approved-email"]),
  allowedEmails: z.array(z.email()).optional(),
  appRoles: z.array(z.string()),
  storage: z.enum(["none", "postgres"]),
  enabled: z.boolean(),
  operationRef: z.uuid(),
  planDigest: digest,
  fenceGeneration: z.number().int().positive(),
});
export type RepositoryProductionSignupPolicy = z.infer<
  typeof repositoryProductionSignupPolicySchema
>;

/** Read only structured accepted access intent and the captured app's role/route catalog. */
export const resolveRepositoryProductionSignupIntent = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The retained private product spec is parsed at this boundary before policy selection.
  spec: unknown,
  description: AppDescription,
  existingAccess?: AppAccessIntent,
): Pick<RepositoryProductionIntent, "access" | "entryPath"> => {
  const requested = z.object({ access: appAccessIntentSchema.optional() }).parse(spec);
  const access = resolveAppAccessIntent(requested.access, existingAccess);
  if (access === undefined || access.mode === "private") {
    return access === undefined ? {} : { access };
  }
  if (access.eligibility === "public" && (access.allowedEmails?.length ?? 0) > 0) {
    throw new Error("repository_production_signup_eligibility_unavailable");
  }
  const catalog = new Set(
    description.backend.kind === "generated-postgres" ? description.backend.roles : [],
  );
  if (
    (description.backend.kind === "generated-postgres" &&
      catalog.size > 0 &&
      access.appRoles.length === 0) ||
    access.appRoles.some((role) => !catalog.has(role))
  ) {
    throw new Error("repository_production_signup_roles_unavailable");
  }
  const entryPath = repositoryProductionSignupPathSchema.parse(
    description.app.browserEntryPath ?? description.app.routes[0] ?? `/${description.app.id}`,
  );
  return { access, entryPath };
};

/** Absent and explicit private remain the same legacy delivery intent. */
export const repositoryProductionSignupSelection = (intent: RepositoryProductionIntent) => {
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Compare the persisted selection without inheriting a different intent.
  const access = resolveAppAccessIntent(intent.access, undefined);
  return access?.mode === "self-signup"
    ? { access, entryPath: intent.entryPath, policyStorage: intent.storage.kind }
    : {};
};

export const sameRepositoryProductionIntent = (
  left: RepositoryProductionIntent,
  right: RepositoryProductionIntent,
) => {
  const normalize = ({
    access: _access,
    entryPath: _entryPath,
    ...intent
  }: RepositoryProductionIntent) => ({
    ...intent,
    ...repositoryProductionSignupSelection({ ...intent, access: _access, entryPath: _entryPath }),
  });
  return isDeepStrictEqual(normalize(left), normalize(right));
};

const selection = (context: RepositoryProductionEffectContext) => {
  const { scope, intent } = context.row.record;
  if (intent.access?.mode !== "self-signup") {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Absence is the explicit private-app selection.
    return undefined;
  }
  if (intent.entryPath === undefined) {
    throw new Error("repository_production_signup_path_unavailable");
  }
  const policy: Pick<
    RepositoryProductionSignupPolicy,
    "version" | "policyId" | "eligibility" | "allowedEmails" | "appRoles" | "storage" | "appPath"
  > = {
    version: 1,
    policyId: repositoryProductionOperationRef(scope),
    eligibility: intent.access.eligibility,
    appRoles: intent.access.appRoles,
    storage: intent.storage.kind,
    appPath: intent.entryPath,
  };
  if (intent.access.allowedEmails !== undefined) {
    policy.allowedEmails = intent.access.allowedEmails;
  }
  return policy;
};
const assertScope = (
  scope: RepositoryProductionScope,
  policy: RepositoryProductionSignupPolicy,
) => {
  if (
    policy.policyId !== repositoryProductionOperationRef(scope) ||
    policy.workspaceId !== scope.authority.workspaceId
  ) {
    throw new Error("repository_production_signup_scope_mismatch");
  }
  if (
    policy.appId !== scope.appId ||
    policy.organizationId !== scope.organizationId ||
    policy.origin !== scope.publicOrigin
  ) {
    throw new Error("repository_production_signup_scope_mismatch");
  }
};
const matches = (
  context: RepositoryProductionEffectContext,
  policy: RepositoryProductionSignupPolicy,
) => {
  assertScope(context.row.record.scope, policy);
  const selected = selection(context);
  if (selected === undefined) {
    return !policy.enabled;
  }
  if (
    !policy.enabled ||
    policy.storage !== selected.storage ||
    policy.eligibility !== selected.eligibility ||
    policy.appPath !== selected.appPath
  ) {
    return false;
  }
  return (
    isDeepStrictEqual([...policy.appRoles].toSorted(), [...selected.appRoles].toSorted()) &&
    isDeepStrictEqual(
      [...(policy.allowedEmails ?? [])].toSorted(),
      [...(selected.allowedEmails ?? [])].toSorted(),
    )
  );
};

type Json = z.infer<ReturnType<typeof z.json>>;
export const createRepositoryProductionSignupPolicy = (ports: {
  request: (
    context: RepositoryProductionEffectContext,
    request: Json,
    readOnly: boolean,
  ) => Promise<Json>;
}) => {
  const read = async (context: RepositoryProductionEffectContext) => {
    const raw = await ports.request(
      context,
      {
        action: "read-signup-policy",
        policyId: repositoryProductionOperationRef(context.row.record.scope),
      },
      true,
    );
    await context.assertCurrent();
    return raw === null ? undefined : repositoryProductionSignupPolicySchema.parse(raw);
  };
  return {
    read,
    async apply(context: RepositoryProductionEffectContext) {
      const selected = selection(context);
      if (selected === undefined) {
        const current = await read(context);
        if (current?.enabled === true) {
          assertScope(context.row.record.scope, current);
          await ports.request(
            context,
            {
              action: "disable-signup-policy",
              policyId: current.policyId,
              policyDigest: current.policyDigest,
            },
            false,
          );
        }
      } else {
        await ports.request(context, { action: "set-signup-policy", policy: selected }, false);
      }
      await context.assertCurrent();
    },
    async reconcile(
      context: RepositoryProductionEffectContext,
    ): Promise<RepositoryProductionObservation> {
      const policy = await read(context);
      if (policy === undefined) {
        return selection(context) === undefined
          ? { state: "applied", receipt: { disabled: true } }
          : { state: "not-applied" };
      }
      return matches(context, policy)
        ? { state: "applied", receipt: policy }
        : { state: "not-applied" };
    },
  };
};
