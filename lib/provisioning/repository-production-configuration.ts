/* oxlint-disable sonarjs/expression-complexity -- All URL components are checked together to reject credentials and redirected origins. */
import { z } from "zod";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { operatorWorkerSourceCaptureSchema } from "./operator-worker-source-capture";
import { createOperatorWorkloadVerifier } from "./hosted-operator-workload";

const id = z.string().min(1);
const origin = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.pathname === "/" &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
const workload = z.strictObject({
  audience: z.url(),
  issuer: z.url(),
  ownerId: id,
  projectId: id,
  subject: id,
  environment: z.literal("production"),
});
const worker = z.strictObject({
  executablePath: id,
  id,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sourceCapture: operatorWorkerSourceCaptureSchema.optional(),
});
const workers = z.strictObject({
  storage: worker.extend({
    id: z.literal("neon-resource-bootstrap-v1"),
    operationScope: z.literal("neon-resource-bootstrap-v1"),
    subcommand: z.literal("neon-resource-bootstrap"),
  }),
  schema: worker.extend({
    id: z.literal("generated-app-protected-installer-v1"),
    operationScope: z.literal("generated-app-release-install-v1"),
    subcommand: z.literal("protected-generated-app-install"),
  }),
  access: worker.extend({
    id: z.literal("generated-app-protected-installer-v1"),
    operationScope: z.literal("generated-app-access-v1"),
    subcommand: z.literal("protected-generated-app-access"),
  }),
  membership: worker.extend({
    id: z.literal("auth-owned-organization-v1"),
    operationScope: z.literal("auth-protected-membership-v1"),
    subcommand: z.literal("auth-protected-membership"),
  }),
  authManagement: worker.extend({
    id: z.literal("auth-app-access-v1"),
    operationScope: z.literal("auth-app-access-v1"),
    subcommand: z.literal("auth-protected-app-access"),
  }),
});
const repository = z.strictObject({
  workspaceId: id,
  projectId: id,
  repositoryId: id,
  repositoryFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/u),
  organization: z.strictObject({ id, name: id }),
  publicOrigin: origin,
  authWorkload: workload,
  authResource: z.strictObject({ resourceId: id, database: id, migratorRole: id, runtimeRole: id }),
  neon: z.strictObject({
    endpoint: id,
    projectId: id,
    branchId: id,
    endpointId: id,
    maintenanceDatabase: id,
    maintenanceRole: id,
  }),
});
export const repositoryProductionConfigurationSchema = z
  .strictObject({
    version: z.literal(1),
    builderWorkload: workload,
    operator: workload,
    sandbox: z.union([
      z.strictObject({ image: id, projectId: id, teamId: id }),
      z.strictObject({
        source: z.strictObject({ type: z.literal("snapshot"), snapshotId: id }),
        projectId: id,
        teamId: id,
      }),
    ]),
    workers,
    connection: z.strictObject({
      connector: id,
      installationId: id,
      subject: z.strictObject({ id, issuer: z.url(), type: z.literal("user") }),
    }),
    vercelCredential: z.strictObject({
      authority: hostedTenantAuthoritySchema,
      installationId: id,
    }),
    repositories: z.array(repository).min(1),
  })
  .superRefine((config, context) => {
    if (
      config.sandbox.projectId !== config.operator.projectId ||
      config.sandbox.teamId !== config.operator.ownerId
    ) {
      context.addIssue({
        code: "custom",
        message: "Sandbox must belong to the protected Production operator.",
      });
    }
    const keys = config.repositories.map((item) => `${item.workspaceId}:${item.repositoryId}`);
    if (new Set(keys).size !== keys.length) {
      context.addIssue({
        code: "custom",
        message: "Each workspace repository has one configured destination.",
      });
    }
    for (const item of config.repositories) {
      if (item.authResource.runtimeRole === item.authResource.migratorRole) {
        context.addIssue({
          code: "custom",
          message: "Runtime and migrator roles must be separate.",
        });
      }
    }
  });
export type RepositoryProductionConfiguration = z.infer<
  typeof repositoryProductionConfigurationSchema
>;
export type RepositoryProductionRepository =
  RepositoryProductionConfiguration["repositories"][number];
/** Explicit Production authority is independent of the retained Preview operator configuration. */
export const readRepositoryProductionConfiguration = (
  environment: Readonly<Record<string, string | undefined>> = process.env,
): RepositoryProductionConfiguration => {
  const raw = environment.REPOSITORY_PRODUCTION_CONFIGURATION;
  if (raw === undefined || raw === "") {
    throw new Error("repository_production_configuration_unavailable");
  }
  const parsed = repositoryProductionConfigurationSchema.parse(JSON.parse(raw));
  createOperatorWorkloadVerifier(parsed.builderWorkload);
  createOperatorWorkloadVerifier(parsed.operator);
  for (const item of parsed.repositories) {
    createOperatorWorkloadVerifier(item.authWorkload);
  }
  return parsed;
};
