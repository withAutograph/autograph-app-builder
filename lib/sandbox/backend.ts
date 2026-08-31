import {
  readHostedDeploymentEnvironment,
  type HostedDeploymentEnvironment,
} from "../hosted/deployment-environment";

export type SandboxBackendKind =
  | "fixture-just-bash"
  | "local-just-bash"
  | "local-microsandbox"
  | "vercel-development"
  | "vercel-preview"
  | "vercel-production"
  | "unsupported-development"
  | "unsupported-vercel";

export type SandboxBackendPlan = {
  kind: SandboxBackendKind;
  blockers: string[];
};

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
    let deploymentEnvironment: HostedDeploymentEnvironment;
    try {
      deploymentEnvironment = readHostedDeploymentEnvironment(environment);
    } catch {
      return {
        kind: "unsupported-vercel",
        blockers: [
          "The hosted App Builder sandbox requires an exact matching Preview or Production environment binding.",
        ],
      };
    }
    return {
      kind:
        deploymentEnvironment === "preview"
          ? "vercel-preview"
          : "vercel-production",
      blockers: [],
    };
  }
  const developmentBinding = [
    environment.APP_BUILDER_EXECUTION_MODE,
    environment.APP_BUILDER_SANDBOX_PROVIDER,
    environment.APP_BUILDER_EXECUTION_BUNDLE,
  ];
  if (
    developmentBinding[0] === "development" &&
    developmentBinding[1] === "vercel" &&
    developmentBinding[2] === "local-development"
  )
    return { kind: "vercel-development", blockers: [] };
  if (developmentBinding.some((value) => value !== undefined))
    return {
      kind: "unsupported-development",
      blockers: [
        "Development execution requires the exact local Vercel Sandbox binding.",
      ],
    };
  if (input.localImageConfigured)
    return { kind: "local-microsandbox", blockers: [] };
  return {
    kind: "local-just-bash",
    blockers: ["No immutable local sandbox image is configured."],
  };
}

/** Constructs only the backend selected by the environment plan. */
export function selectSandboxDefinition<Hosted, Local, NonExecuting>(
  kind: SandboxBackendKind,
  factories: {
    localMicrosandbox: () => Local;
    nonExecuting: () => NonExecuting;
    vercelHosted: () => Hosted;
  },
): Hosted | Local | NonExecuting {
  if (kind === "unsupported-development" || kind === "unsupported-vercel")
    throw new Error(
      "The App Builder sandbox environment binding is unsupported.",
    );
  if (isVercelSandboxBackend(kind)) return factories.vercelHosted();
  if (kind === "local-microsandbox") return factories.localMicrosandbox();
  return factories.nonExecuting();
}

export function isVercelSandboxBackend(
  kind: SandboxBackendKind,
): kind is "vercel-development" | "vercel-preview" | "vercel-production" {
  return (
    kind === "vercel-development" ||
    kind === "vercel-preview" ||
    kind === "vercel-production"
  );
}

export function isHostedVercelSandboxBackend(
  kind: SandboxBackendKind,
): kind is "vercel-preview" | "vercel-production" {
  return kind === "vercel-preview" || kind === "vercel-production";
}
