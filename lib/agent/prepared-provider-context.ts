import { z } from "zod";

import type { BuilderHandoffIntent } from "../handoff/contracts";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { parseRepositoryReference } from "../integrations/repository-access";
import type { RepositoryAccessResult } from "../integrations/repository-access";
import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { RepositoryAccessToolInput } from "./repository-access-tool";

// Cache infrastructure only. Handoff, membership, bindings, and decrypted
// credentials are re-read for the authenticated tenant on each invocation.
let providerDatabase: ReturnType<typeof openHostedPostgresDatabase> | undefined;

// The additive providers field is supplied by the handoff backend. The
// intersection also accepts records written before provider selections existed.
type PreparedIntent = BuilderHandoffIntent & {
  providers?: { githubInstallationId?: string; vercelInstallationId?: string };
};

/** Call only after the durable handoff reader has verified the session. */
export function preparedHandoffReturnPath(sessionAuth: unknown) {
  const parsed = z
    .object({
      initiator: z.object({
        attributes: z.object({
          "autograph:source-handoff-id": z.string().uuid(),
        }),
      }),
    })
    .safeParse(sessionAuth);
  return parsed.success
    ? (`/handoff/${parsed.data.initiator.attributes["autograph:source-handoff-id"]}` as const)
    : undefined;
}

export function preparedGitHubRepository(intent: PreparedIntent) {
  return (
    intent.repository.resolvedFullName ??
    (intent.provisioning?.github.status === "succeeded"
      ? intent.provisioning.github.fullName
      : undefined)
  );
}

export function withPreparedGitHubSelection(
  input: RepositoryAccessToolInput,
  intent: PreparedIntent | undefined,
): RepositoryAccessToolInput {
  if (!intent || input.selectedInstallationId !== undefined) return input;
  const preparedRepository = preparedGitHubRepository(intent);
  if (preparedRepository?.toLowerCase() !== input.repository.toLowerCase()) return input;
  const selectedInstallationId =
    intent.providers?.githubInstallationId ??
    (intent.provisioning?.github.status === "succeeded"
      ? intent.provisioning.github.installationId
      : undefined);
  return selectedInstallationId ? { ...input, selectedInstallationId } : input;
}

type VercelCredential = { binding: VercelInstallationBinding; token: string };
type Authority = ReturnType<typeof exactForwardedSessionAuthority>["authority"];
type VercelScope = {
  installationId: string;
  type: "team" | "user";
  id: string;
  slug: string;
};
export type PreparedVercelAccess =
  | { status: "not-selected" }
  | { status: "resource-unavailable"; action: "review-selection" }
  | {
      status: "authorization-required";
      action: "reconnect";
      reconnectUrl?: string;
    }
  | { status: "provider-unavailable"; action: "retry"; retryable: true }
  | {
      status: "ready";
      scope: VercelScope;
      project?: { id: string; name: string };
    };

const unavailable = (): PreparedVercelAccess => ({
  status: "provider-unavailable",
  action: "retry",
  retryable: true,
});
const reconnect = (): PreparedVercelAccess => ({
  status: "authorization-required",
  action: "reconnect",
});

async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid-response");
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 2 * 1024 * 1024) {
      await reader.cancel();
      throw new Error("invalid-response");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

/** Server-only credential read followed by a fresh, read-only provider request. */
export async function readPreparedVercelAccess(input: {
  intent: PreparedIntent;
  authority: Authority;
  readCredential: (input: {
    authority: Authority;
    installationId: string;
  }) => Promise<VercelCredential | undefined>;
  fetch?: typeof fetch;
  apiOrigin?: string;
}): Promise<PreparedVercelAccess> {
  const project =
    input.intent.provisioning?.vercel.status === "succeeded"
      ? input.intent.provisioning.vercel
      : undefined;
  const installationId = input.intent.providers?.vercelInstallationId ?? project?.installationId;
  if (!installationId) return { status: "not-selected" };
  try {
    const credential = await input.readCredential({
      authority: input.authority,
      installationId,
    });
    if (!credential || !credential.binding.active) return reconnect();
    if (credential.binding.installationId !== installationId) return unavailable();
    const { binding, token } = credential;
    if (
      project &&
      (project.installationId !== installationId ||
        project.scope.id !== binding.scopeId ||
        project.scope.type !== binding.scopeType)
    )
      return { status: "resource-unavailable", action: "review-selection" };
    const path = project
      ? `/v9/projects/${encodeURIComponent(project.projectId)}`
      : binding.scopeType === "team"
        ? `/v2/teams/${encodeURIComponent(binding.scopeId)}`
        : "/v2/user";
    const url = new URL(`${input.apiOrigin ?? "https://api.vercel.com"}${path}`);
    if (project && binding.scopeType === "team") url.searchParams.set("teamId", binding.scopeId);
    const response = await (input.fetch ?? fetch)(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "autograph-app-builder",
      },
    });
    // Classify status before reading provider bodies, which can contain secrets
    // or an HTML outage page. Match the existing provider credential semantics.
    if (response.status === 403 && response.headers.has("retry-after")) {
      await response.body?.cancel();
      return unavailable();
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return { status: "resource-unavailable", action: "review-selection" };
    }
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      return reconnect();
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return unavailable();
    }
    const body = await boundedJson(response);
    const scope: VercelScope = {
      installationId,
      type: binding.scopeType,
      id: binding.scopeId,
      slug: binding.slug,
    };
    if (project) {
      const observed = z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          accountId: z.string().min(1).optional(),
        })
        .parse(body);
      if (
        observed.id !== project.projectId ||
        (observed.accountId !== undefined && observed.accountId !== binding.scopeId)
      )
        return unavailable();
      return {
        status: "ready",
        scope,
        project: { id: observed.id, name: observed.name },
      };
    }
    const observed =
      binding.scopeType === "team"
        ? z.object({ id: z.string() }).parse(body)
        : z.object({ user: z.object({ id: z.string() }) }).parse(body).user;
    if (observed.id !== binding.scopeId) return unavailable();
    return { status: "ready", scope };
  } catch {
    return unavailable();
  }
}

export function createPreparedAppContextReader(input: {
  readHandoff: (sessionAuth: unknown) => Promise<PreparedIntent | undefined>;
  github: (
    sessionAuth: unknown,
    input: RepositoryAccessToolInput,
  ) => Promise<RepositoryAccessResult>;
  vercel: (sessionAuth: unknown, intent: PreparedIntent) => Promise<PreparedVercelAccess>;
}) {
  return async (sessionAuth: unknown) => {
    // The trusted reader establishes tenant ownership before any provider work.
    const intent = await input.readHandoff(sessionAuth);
    if (!intent) return { status: "not-prepared" as const };
    const repository = preparedGitHubRepository(intent);
    const [github, vercel] = await Promise.all([
      repository
        ? input
            .github(sessionAuth, withPreparedGitHubSelection({ repository }, intent))
            .catch((): RepositoryAccessResult => ({
              status: "provider-unavailable",
              repository: parseRepositoryReference(repository),
            }))
        : Promise.resolve(undefined),
      input.vercel(sessionAuth, intent).catch(unavailable),
    ]);
    const returnTo = preparedHandoffReturnPath(sessionAuth);
    const reconnectUrl = (provider: "github" | "vercel") =>
      returnTo
        ? new URL(
            `/${provider}/installations?${new URLSearchParams({ returnTo })}`,
            // readHandoff has already verified this originating session.
            z.object({ initiator: z.object({ issuer: z.string().url() }) }).parse(sessionAuth)
              .initiator.issuer,
          ).toString()
        : undefined;
    // Explicit projection: never spread auth, credentials, raw provider payloads,
    // or the provisioning journal into durable model-visible output.
    return {
      status: "prepared" as const,
      app: {
        name: intent.appName,
        id: intent.appId,
        brief: intent.brief,
        modelId: intent.modelId,
        connections: [...intent.connections],
      },
      repository: {
        requestedName: intent.repository.requestedName,
        private: intent.repository.private,
        ...(repository ? { fullName: repository } : {}),
      },
      resources: {
        github:
          intent.provisioning?.github.status === "succeeded"
            ? {
                repositoryId: intent.provisioning.github.repositoryId,
                fullName: intent.provisioning.github.fullName,
                installationId: intent.provisioning.github.installationId,
              }
            : undefined,
        vercel:
          intent.provisioning?.vercel.status === "succeeded"
            ? {
                projectId: intent.provisioning.vercel.projectId,
                name: intent.provisioning.vercel.name,
                installationId: intent.provisioning.vercel.installationId,
                scope: {
                  id: intent.provisioning.vercel.scope.id,
                  type: intent.provisioning.vercel.scope.type,
                  slug: intent.provisioning.vercel.scope.slug,
                },
              }
            : undefined,
      },
      provisioning: intent.provisioning
        ? {
            github: intent.provisioning.github.status,
            vercel: intent.provisioning.vercel.status,
          }
        : undefined,
      access: {
        github: github
          ? {
              status: github.status,
              ...(github.status === "ready"
                ? {
                    scope: {
                      installationId: github.scope.installationId,
                      accountLogin: github.scope.accountLogin,
                      accountType: github.scope.accountType,
                    },
                  }
                : {}),
              ...(github.status === "authorization-required"
                ? {
                    action: "reconnect" as const,
                    reconnectUrl: reconnectUrl("github"),
                  }
                : {}),
              ...(github.status === "provider-unavailable"
                ? { action: "retry" as const, retryable: true }
                : {}),
            }
          : { status: "not-prepared" as const },
        vercel:
          vercel.status === "authorization-required"
            ? { ...vercel, reconnectUrl: reconnectUrl("vercel") }
            : vercel,
      },
    };
  };
}

export async function readPreparedAppContext(sessionAuth: unknown) {
  const { readPreparedHandoffContext } = await import("./handoff-context");
  return createPreparedAppContextReader({
    readHandoff: readPreparedHandoffContext,
    async github(auth, value) {
      const { repositoryAccessRuntimeForSession } =
        await import("./deployment-repository-access-runtime");
      return (await repositoryAccessRuntimeForSession(auth)).classify(value);
    },
    async vercel(auth, intent) {
      const { authority, principal } = exactForwardedSessionAuthority(auth);
      const [
        { createPostgresWorkspaceMembership },
        { openHostedPostgresDatabase },
        { readActiveVercelInstallationToken },
        { readVercelIntegrationEnvironment },
        { providerEmulationEnvironment, readProviderEmulation },
        { providerEmulationFetch },
      ] = await Promise.all([
        import("../eve/postgres-workspace-membership"),
        import("../mcp/hosted-route"),
        import("../integrations/postgres-vercel-installation"),
        import("../integrations/vercel-installation"),
        import("../integrations/local-provider-emulation"),
        import("../integrations/provider-emulation-fetch"),
      ]);
      return readPreparedVercelAccess({
        intent,
        authority,
        async readCredential(value) {
          const environment = providerEmulationEnvironment(process.env);
          const config = readVercelIntegrationEnvironment(environment);
          if (config.issuer !== authority.issuer || config.resource !== authority.audience)
            throw new Error("Provider authority is unavailable.");
          if (providerDatabase === undefined)
            providerDatabase = openHostedPostgresDatabase(environment.DATABASE_URL ?? "");
          const database = providerDatabase;
          if (
            !(await createPostgresWorkspaceMembership(database).isMember({
              principal,
              workspaceId: authority.workspaceId,
            }))
          )
            throw new Error("Provider authority is unavailable.");
          return readActiveVercelInstallationToken({
            ...value,
            database,
            config,
          });
        },
        ...(() => {
          const emulation = readProviderEmulation(process.env);
          return emulation
            ? {
                apiOrigin: emulation.vercelOrigin,
                fetch: ((resource, init) =>
                  providerEmulationFetch(resource as URL, init, emulation)) as typeof fetch,
              }
            : {};
        })(),
      });
    },
  })(sessionAuth);
}
