import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import type {
  SandboxBackend,
  SandboxBackendHandle,
  SandboxBackendPrewarmInput,
} from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";

import { assertHostedSandboxCommandAuthority } from "./deployment-execution-lease";
import { createAuthorizedSandboxBackend } from "./sandbox-command-adapter";
import { readVercelSessionGitSource } from "./vercel-session-source";

export interface HostedVercelBackendOptions {
  readonly fetch?: ProviderFetch;
  readonly env?: Readonly<Record<string, string>>;
  readonly networkPolicy: "allow-all";
  readonly sessionCreateOptions: (context?: {
    readonly session: { readonly id: string };
  }) => {
    readonly networkPolicy: "deny-all" | "allow-all";
    readonly source?: {
      readonly type: "git";
      readonly url: string;
      readonly username: "x-access-token";
      readonly password: string;
    };
  };
}

export type HostedVercelBackendFactory = (
  options: HostedVercelBackendOptions,
) => ReturnType<typeof vercel>;

type RuntimeRecoveryPrewarmInput<BO = Record<string, never>> = Readonly<{
  bootstrap: NonNullable<SandboxBackendPrewarmInput<BO>["bootstrap"]>;
  seedFiles: SandboxBackendPrewarmInput<BO>["seedFiles"];
}>;

export interface HostedVercelBackendInput {
  readonly factory?: HostedVercelBackendFactory;
  readonly bootstrapNetworkHosts?: readonly string[];
  readonly sandboxEnvironment?: Readonly<Record<string, string>>;
  /** Maps Eve's authored key to a provider cache key when reuse has a narrower identity. */
  readonly providerTemplateKey?: (authoredTemplateKey: string) => string;
  /** Reuses already-open provider sessions within one local Eve process. */
  readonly reuseProcessSessionHandles?: boolean;
  /** Legacy callers may still supply this while migrating off templates. */
  readonly runtimeRecoveryPrewarmInput?: () => RuntimeRecoveryPrewarmInput;
}

// Provider command responses may legitimately remain open for the full
// repository-operation window. Keep the transport deadline above that window
// so the HTTP wrapper does not discard a successful sandbox operation.
const PROVIDER_REQUEST_TIMEOUT_MS = 150_000;
const PROVIDER_RETRY_DELAY_MS = 250;

function retryableProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const status = (error as Error & { status?: unknown }).status;
  if (typeof status === "number" && (status === 429 || status >= 500))
    return true;
  return /fetch failed|network|timed? ?out|econnreset|eai_again|socket/i.test(
    `${error.message} ${(error as Error & { cause?: unknown }).cause instanceof Error ? (error as Error & { cause: Error }).cause.message : ""}`,
  );
}

function providerDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) return "unknown";
  const cause = (error as Error & { cause?: unknown }).cause;
  const code =
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof cause.code === "string"
      ? cause.code
      : "provider_error";
  return `Vercel Sandbox request failed (${code})`;
}

type ProviderFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createProviderFetch(
  fetchImpl: typeof fetch = fetch,
  requestTimeoutMs = PROVIDER_REQUEST_TIMEOUT_MS,
): ProviderFetch {
  return async (input, init) => {
    const original = new Request(input, init);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), requestTimeoutMs);
      const signal = original.signal.aborted
        ? original.signal
        : AbortSignal.any([original.signal, timeout.signal]);
      try {
        const response = await fetchImpl(original.clone(), { signal });
        if (
          attempt === 0 &&
          (response.status === 429 || response.status >= 500)
        ) {
          await response.body?.cancel();
          console.warn(
            `[sandbox] ${original.method} ${new URL(original.url).origin}${new URL(original.url).pathname}: provider_status_${response.status}; retrying once`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, PROVIDER_RETRY_DELAY_MS),
          );
          continue;
        }
        return response;
      } catch (error) {
        const callerCancelled = original.signal.aborted;
        const providerRequestTimedOut =
          timeout.signal.aborted && !callerCancelled;
        if (
          attempt === 0 &&
          !callerCancelled &&
          (providerRequestTimedOut || retryableProviderFailure(error))
        ) {
          console.warn(
            `[sandbox] ${original.method} ${new URL(original.url).origin}${new URL(original.url).pathname}: ${providerDiagnostic(error)}; retrying once`,
          );
          await new Promise((resolve) =>
            setTimeout(resolve, PROVIDER_RETRY_DELAY_MS),
          );
          continue;
        }
        console.warn(
          `[sandbox] ${original.method} ${new URL(original.url).origin}${new URL(original.url).pathname}: ${providerDiagnostic(error)}`,
        );
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error("unreachable");
  };
}

function createRuntimeRecoveringBackend<BO, SO>(input: {
  readonly backend: SandboxBackend<BO, SO>;
  readonly providerTemplateKey?: (authoredTemplateKey: string) => string;
  readonly resolvePrewarmInput: () => RuntimeRecoveryPrewarmInput<BO>;
}): SandboxBackend<BO, SO> {
  const providerTemplateKey = (authoredTemplateKey: string | null) =>
    authoredTemplateKey === null
      ? null
      : (input.providerTemplateKey?.(authoredTemplateKey) ??
        authoredTemplateKey);
  return {
    name: input.backend.name,
    prewarm: (prewarmInput) =>
      input.backend.prewarm({
        ...prewarmInput,
        templateKey: providerTemplateKey(prewarmInput.templateKey)!,
      }),
    async create(createInput) {
      const providerCreateInput = {
        ...createInput,
        templateKey: providerTemplateKey(createInput.templateKey),
      };
      try {
        return await input.backend.create(providerCreateInput);
      } catch (error) {
        if (
          providerCreateInput.templateKey === null ||
          !SandboxTemplateNotProvisionedError.is(error) ||
          error.templateKey !== providerCreateInput.templateKey
        )
          throw error;

        const recovery = input.resolvePrewarmInput();
        await input.backend.prewarm({
          bootstrap: recovery.bootstrap,
          runtimeContext: createInput.runtimeContext,
          seedFiles: recovery.seedFiles,
          templateKey: providerCreateInput.templateKey,
        });
        return await input.backend.create(providerCreateInput);
      }
    },
  };
}

function createProcessSessionReusingBackend<BO, SO>(
  backend: SandboxBackend<BO, SO>,
): SandboxBackend<BO, SO> {
  const processState = globalThis as typeof globalThis & {
    __autographDevelopmentSandboxHandles?: Map<
      string,
      Promise<SandboxBackendHandle<unknown>>
    >;
  };
  const sessions = (processState.__autographDevelopmentSandboxHandles ??=
    new Map()) as Map<string, Promise<SandboxBackendHandle<SO>>>;
  return {
    name: backend.name,
    prewarm: (input) => backend.prewarm(input),
    create(input) {
      const key = JSON.stringify([
        backend.name,
        input.runtimeContext.appRoot,
        input.sessionKey,
        input.templateKey,
      ]);
      const existing = sessions.get(key);
      if (existing !== undefined) {
        console.log(
          JSON.stringify({
            event: "autograph.local.sandbox-handle",
            state: "hit",
            sessionKey: input.sessionKey,
          }),
        );
        return existing;
      }
      console.log(
        JSON.stringify({
          event: "autograph.local.sandbox-handle",
          state: "miss",
          sessionKey: input.sessionKey,
        }),
      );

      const pending: Promise<SandboxBackendHandle<SO>> = backend
        .create(input)
        .then((handle) => {
          let closed = false;
          const close = async (kind: "stop" | "shutdown") => {
            if (closed) return;
            closed = true;
            if (sessions.get(key) === pending) sessions.delete(key);
            await handle[kind]();
          };
          return {
            session: handle.session,
            useSessionFn: handle.useSessionFn,
            captureState: () => handle.captureState(),
            stop: () => close("stop"),
            shutdown: () => close("shutdown"),
          } satisfies SandboxBackendHandle<SO>;
        })
        .catch((error: unknown) => {
          if (sessions.get(key) === pending) sessions.delete(key);
          throw error;
        });
      sessions.set(key, pending);
      return pending;
    },
  };
}

/**
 * Keeps network authority different for the reusable template and every live
 * session. Only template construction may download the pinned toolchain.
 */
export function createHostedVercelBackend(
  input: HostedVercelBackendInput,
): ReturnType<typeof vercel> {
  // Eve merges session-only creation options into the provider request,
  // although its public return type currently names only mounts. Keep the
  // compatibility assertion isolated at this boundary.
  const factory =
    input.factory ?? (vercel as unknown as HostedVercelBackendFactory);
  const backend = factory({
    ...(input.sandboxEnvironment === undefined
      ? {}
      : { env: { ...input.sandboxEnvironment } }),
    networkPolicy: "allow-all",
    // Eve resolves this for every fresh live session, including a replacement
    // created after the provider loses the previously recorded sandbox.
    sessionCreateOptions: (context) => {
      const source =
        context === undefined
          ? undefined
          : readVercelSessionGitSource(context.session.id);
      return {
        networkPolicy: "allow-all" as const,
        ...(source === undefined
          ? {}
          : {
              // Eve forwards session-specific source options into the
              // official Vercel `Sandbox.create` call when no template is
              // present. The installation token remains provider-only.
              source: {
                type: "git" as const,
                url: source.url,
                username: "x-access-token" as const,
                password: source.token,
              },
            }),
      };
    },
  });
  const authorized = createAuthorizedSandboxBackend({
    backend,
    authorizeSessionCommand: (sessionId) =>
      assertHostedSandboxCommandAuthority({ sessionId }),
  });
  // A missing snapshot or provider cache is not an authority failure. Let the
  // normal Vercel Sandbox create path return the provider's actual result;
  // callers may rebuild an optimization later, but never block on it here.
  return authorized as ReturnType<typeof vercel>;
}
