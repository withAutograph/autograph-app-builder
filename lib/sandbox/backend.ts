export type SandboxBackendKind =
  | "fixture-just-bash"
  | "local-just-bash"
  | "local-microsandbox"
  | "vercel-preview"
  | "unsupported-vercel";

export type SandboxBackendPlan = {
  kind: SandboxBackendKind;
  blockers: string[];
};

export const VERCEL_SANDBOX_ARTIFACT_BLOCKER =
  "The pinned Vercel Sandbox toolchain snapshot has no digest-bound offline dependency cache or private Arrusted source-acquisition artifact, so hosted typed planning remains unavailable.";

export function isHostedVercelRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return environment.VERCEL === "1";
}

/** Selects only execution environments whose isolation semantics are known. */
export function sandboxBackendPlan(input: {
  environment?: Readonly<Record<string, string | undefined>>;
  fixture: boolean;
  localImageConfigured: boolean;
}): SandboxBackendPlan {
  const environment = input.environment ?? process.env;
  if (input.fixture) return { kind: "fixture-just-bash", blockers: [] };
  if (isHostedVercelRuntime(environment)) {
    if (environment.VERCEL_ENV !== "preview")
      return {
        kind: "unsupported-vercel",
        blockers: [
          "The hosted App Builder sandbox is enabled only for Vercel Preview.",
        ],
      };
    return {
      kind: "vercel-preview",
      blockers: [VERCEL_SANDBOX_ARTIFACT_BLOCKER],
    };
  }
  if (input.localImageConfigured)
    return { kind: "local-microsandbox", blockers: [] };
  return {
    kind: "local-just-bash",
    blockers: ["No immutable local sandbox image is configured."],
  };
}
