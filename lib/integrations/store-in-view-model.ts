import { z } from "zod";

const githubLoginSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u);

export const githubRepositoryAccessSchema = z
  .object({
    action: z.enum(["connect", "update"]),
    provider: z.literal("github"),
    repository: z
      .object({
        fullName: z
          .string()
          .min(3)
          .max(201)
          .regex(/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/u),
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9_.-]+$/u),
        owner: githubLoginSchema,
      })
      .strict()
      .superRefine((repository, context) => {
        if (repository.fullName !== `${repository.owner}/${repository.name}`)
          context.addIssue({
            code: "custom",
            message: "Repository fullName must match owner and name.",
            path: ["fullName"],
          });
      })
      .optional(),
    scopes: z
      .array(
        z
          .object({
            accountLogin: githubLoginSchema,
            accountType: z.enum(["Organization", "User"]),
            installationId: z.string().regex(/^[1-9][0-9]*$/u),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();

export type GitHubRepositoryAccess = z.infer<typeof githubRepositoryAccessSchema>;

interface StoreInScopeView {
  id: string;
  label: string;
  detail?: string;
}

export interface GitHubStoreInViewModel {
  action: "connect" | "update";
  actionLabel: "Connect GitHub" | "Update GitHub access";
  title: "Connect GitHub" | "Update GitHub access";
  description: string;
  desiredRepository?: string;
  scopes: StoreInScopeView[];
  scopeSummary: string;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function githubStoreInViewModel(input: {
  action: "connect" | "update";
  desiredRepository?: string;
  scopes?: readonly StoreInScopeView[];
}): GitHubStoreInViewModel {
  const scopes = [...(input.scopes ?? [])];
  const actionLabel =
    input.action === "connect" ? ("Connect GitHub" as const) : ("Update GitHub access" as const);
  const desiredRepository = input.desiredRepository?.trim() || undefined;
  let scopeSummary = "No GitHub account connected yet";
  if (scopes.length === 1) {
    scopeSummary = `Connected to ${scopes[0]?.label}`;
  } else if (scopes.length > 1) {
    scopeSummary = `${scopes.length} GitHub accounts connected`;
  }

  let description = "Update which repositories Autograph can access.";
  if (desiredRepository) {
    description =
      input.action === "connect"
        ? `Connect GitHub so Autograph can access ${desiredRepository}.`
        : `Update GitHub access to include ${desiredRepository}.`;
  } else if (input.action === "connect") {
    description = "Connect GitHub to choose where this app should live.";
  }

  const viewModel: GitHubStoreInViewModel = {
    action: input.action,
    actionLabel,
    description,
    scopeSummary,
    scopes,
    title: actionLabel,
  };
  if (desiredRepository !== undefined) viewModel.desiredRepository = desiredRepository;
  return viewModel;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function githubRepositoryAccessViewModel(
  access: GitHubRepositoryAccess,
): GitHubStoreInViewModel {
  return githubStoreInViewModel({
    action: access.action,
    ...(access.repository === undefined ? {} : { desiredRepository: access.repository.fullName }),
    scopes: access.scopes.map((scope) => ({
      detail: scope.accountType,
      id: scope.installationId,
      label: scope.accountLogin,
    })),
  });
}
