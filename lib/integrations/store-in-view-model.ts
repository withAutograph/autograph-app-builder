import { z } from "zod";

const githubLoginSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/u);

export const githubRepositoryAccessSchema = z.strictObject({
  action: z.enum(["connect", "update"]),
  provider: z.literal("github"),
  repository: z
    .strictObject({
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
    .superRefine((repository, context) => {
      if (repository.fullName !== `${repository.owner}/${repository.name}`) {
        context.addIssue({
          code: "custom",
          message: "Repository fullName must match owner and name.",
          path: ["fullName"],
        });
      }
    })
    .optional(),
  scopes: z
    .array(
      z.strictObject({
        accountLogin: githubLoginSchema,
        accountType: z.enum(["Organization", "User"]),
        installationId: z.string().regex(/^[1-9][0-9]*$/u),
      }),
    )
    .max(100),
});

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
export function githubConnectionPrompt(repository?: string) {
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- An empty repository name uses the generic prompt.
  return `Connect GitHub so Autograph can access ${repository || "the repository for this app"}. GitHub will ask you to approve access if needed.`;
  /* oxlint-enable typescript/strict-boolean-expressions */
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
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- Treat an empty trimmed repository name as absent.
  const desiredRepository = input.desiredRepository?.trim() || undefined;
  /* oxlint-enable typescript/strict-boolean-expressions */
  let scopeSummary = "No GitHub account connected yet";
  if (scopes.length === 1) {
    scopeSummary = `Connected to ${scopes[0]?.label}`;
  } else if (scopes.length > 1) {
    scopeSummary = `${scopes.length} GitHub accounts connected`;
  }

  let description = "Update which repositories Autograph can access.";
  if (desiredRepository !== undefined) {
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
  if (desiredRepository !== undefined) {
    viewModel.desiredRepository = desiredRepository;
  }
  return viewModel;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function githubRepositoryAccessViewModel(
  access: GitHubRepositoryAccess,
): GitHubStoreInViewModel {
  const selection: Pick<
    Parameters<typeof githubStoreInViewModel>[0],
    "action" | "desiredRepository"
  > = { action: access.action };
  if (access.repository !== undefined) {
    selection.desiredRepository = access.repository.fullName;
  }
  return githubStoreInViewModel({
    ...selection,
    scopes: access.scopes.map((scope) => ({
      detail: scope.accountType,
      id: scope.installationId,
      label: scope.accountLogin,
    })),
  });
}
