import { z } from "zod";

const githubLoginSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u);

export const githubRepositoryAccessSchema = z
  .object({
    provider: z.literal("github"),
    action: z.enum(["connect", "update"]),
    repository: z
      .object({
        owner: githubLoginSchema,
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9_.-]+$/u),
        fullName: z
          .string()
          .min(3)
          .max(201)
          .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u),
      })
      .strict()
      .superRefine((repository, context) => {
        if (repository.fullName !== `${repository.owner}/${repository.name}`)
          context.addIssue({
            code: "custom",
            path: ["fullName"],
            message: "Repository fullName must match owner and name.",
          });
      })
      .optional(),
    scopes: z
      .array(
        z
          .object({
            installationId: z.string().regex(/^[1-9][0-9]*$/u),
            accountLogin: githubLoginSchema,
            accountType: z.enum(["Organization", "User"]),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type GitHubRepositoryAccess = z.infer<
  typeof githubRepositoryAccessSchema
>;

type StoreInScopeView = {
  id: string;
  label: string;
  detail?: string;
};

export type GitHubStoreInViewModel = {
  action: "connect" | "update";
  actionLabel: "Connect GitHub" | "Update GitHub access";
  title: "Connect GitHub" | "Update GitHub access";
  description: string;
  desiredRepository?: string;
  scopes: StoreInScopeView[];
  scopeSummary: string;
};

export function githubStoreInViewModel(input: {
  action: "connect" | "update";
  desiredRepository?: string;
  scopes?: readonly StoreInScopeView[];
}): GitHubStoreInViewModel {
  const scopes = [...(input.scopes ?? [])];
  const actionLabel =
    input.action === "connect"
      ? ("Connect GitHub" as const)
      : ("Update GitHub access" as const);
  const desiredRepository = input.desiredRepository?.trim() || undefined;
  const scopeSummary =
    scopes.length === 0
      ? "No GitHub account connected yet"
      : scopes.length === 1
        ? `Connected to ${scopes[0]!.label}`
        : `${scopes.length} GitHub accounts connected`;
  const description = desiredRepository
    ? input.action === "connect"
      ? `Connect GitHub so Autograph can access ${desiredRepository}.`
      : `Update GitHub access to include ${desiredRepository}.`
    : input.action === "connect"
      ? "Connect GitHub to choose where this app should live."
      : "Update which repositories Autograph can access.";

  return {
    action: input.action,
    actionLabel,
    title: actionLabel,
    description,
    ...(desiredRepository === undefined ? {} : { desiredRepository }),
    scopes,
    scopeSummary,
  };
}

export function githubRepositoryAccessViewModel(
  access: GitHubRepositoryAccess,
): GitHubStoreInViewModel {
  return githubStoreInViewModel({
    action: access.action,
    ...(access.repository === undefined
      ? {}
      : { desiredRepository: access.repository.fullName }),
    scopes: access.scopes.map((scope) => ({
      id: scope.installationId,
      label: scope.accountLogin,
      detail: scope.accountType,
    })),
  });
}
