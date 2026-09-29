import { SandboxTemplateNotProvisionedError } from "eve/sandbox";
import type { SandboxBackend, SandboxBackendHandle, SandboxBackendPrewarmInput } from "eve/sandbox";
import { vercel } from "eve/sandbox/vercel";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import { assertHostedSandboxCommandAuthority } from "./deployment-execution-lease";
import { createAuthorizedSandboxBackend } from "./sandbox-command-adapter";
import { hasVercelSessionGitSource, resolveVercelSessionGitSource } from "./vercel-session-source";
import { withVercelPreviewProvider } from "./vercel-preview-provider";

export interface HostedVercelBackendOptions {
  readonly fetch?: ProviderFetch;
  readonly env?: Readonly<Record<string, string>>;
  readonly networkPolicy: "allow-all";
  readonly sessionCreateOptions: (context?: {
    readonly session: { readonly id: string };
  }) => Promise<{
    readonly networkPolicy: "allow-all";
    readonly source?: {
      readonly type: "git";
      readonly url: string;
      readonly username: "x-access-token";
      readonly password: string;
      readonly revision?: string;
    };
  }>;
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
  readonly sandboxEnvironment?: Readonly<Record<string, string>>;
  /** Maps Eve's authored key to a provider cache key when reuse has a narrower identity. */
  readonly providerTemplateKey?: (authoredTemplateKey: string) => string;
  /** Reuses already-open provider sessions within one local Eve process. */
  readonly reuseProcessSessionHandles?: boolean;
  /** Legacy callers may still supply this while migrating off templates. */
  readonly runtimeRecoveryPrewarmInput?: () => RuntimeRecoveryPrewarmInput;
}

const PROVIDER_RETRY_DELAY_MS = 250;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function retryableProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { status } = error as Error & { status?: unknown };
  if (typeof status === "number" && (status === 429 || status >= 500)) {
    return true;
  }
  return /fetch failed|network|timed? ?out|econnreset|eai_again|socket/iu.test(
    `${error.message} ${(error as Error & { cause?: unknown }).cause instanceof Error ? (error as Error & { cause: Error }).cause.message : ""}`,
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function providerDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown";
  }
  const { cause } = error as Error & { cause?: unknown };
  const code =
    cause && typeof cause === "object" && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : "provider_error";
  return `Vercel Sandbox request failed (${code})`;
}

type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createProviderFetch(fetchImpl: typeof fetch = fetch): ProviderFetch {
  return async (input, init) => {
    const original = new Request(input, init);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        const response = await fetchImpl(original.clone(), { signal: original.signal });
        if (attempt === 0 && (response.status === 429 || response.status >= 500)) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
          await response.body?.cancel();
          console.warn(
            `[sandbox] ${original.method} ${new URL(original.url).origin}${new URL(original.url).pathname}: provider_status_${response.status}; retrying once`,
          );
          // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
          await delay(PROVIDER_RETRY_DELAY_MS);
          continue;
        }
        return response;
      } catch (error) {
        const callerCancelled = original.signal.aborted;
        if (attempt === 0 && !callerCancelled && retryableProviderFailure(error)) {
          console.warn(
            `[sandbox] ${original.method} ${new URL(original.url).origin}${new URL(original.url).pathname}: ${providerDiagnostic(error)}; retrying once`,
          );
          // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
          await delay(PROVIDER_RETRY_DELAY_MS);
          continue;
        }
        console.warn(
          `[sandbox] ${original.method} ${new URL(original.url).origin}${new URL(original.url).pathname}: ${providerDiagnostic(error)}`,
        );
        throw error;
      }
    }
    throw new Error("unreachable");
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function createRuntimeRecoveringBackend<BO, SO>(input: {
  readonly backend: SandboxBackend<BO, SO>;
  readonly providerTemplateKey?: (authoredTemplateKey: string) => string;
}): SandboxBackend<BO, SO> {
  const providerTemplateKey = (authoredTemplateKey: string | null) =>
    authoredTemplateKey === null
      ? null
      : (input.providerTemplateKey?.(authoredTemplateKey) ?? authoredTemplateKey);
  const providerPrewarmTemplateKey = (authoredTemplateKey: string) =>
    input.providerTemplateKey?.(authoredTemplateKey) ?? authoredTemplateKey;
  const selectedCheckoutCommand = `if test -e /workspace/repository || test -L /workspace/repository; then
  if git -C /workspace/repository rev-parse --is-inside-work-tree >/dev/null 2>&1; then echo found; else echo occupied; fi
elif git -C /vercel/sandbox rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo found
elif find /workspace -mindepth 2 -maxdepth 2 -name .git -print -quit | grep -q .; then
  echo found
else
  echo missing
fi`;
  const selectedCheckoutStatus = async (handle: SandboxBackendHandle<SO>) => {
    const result = await handle.session.run({
      command: selectedCheckoutCommand,
      workingDirectory: "/workspace",
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `Builder could not inspect the selected GitHub checkout in its Vercel sandbox (exit ${result.exitCode}). Check the sandbox command logs and retry.`,
      );
    }
    return result.stdout.trim();
  };
  return {
    async create(createInput) {
      // Eve may tag a provider attempt with a different identifier than its
      // durable session key. Either exact selected-source binding must bypass
      // the starter template so Vercel can clone the Git repository.
      const selectedGitSource =
        (createInput.tags?.sessionId !== undefined &&
          hasVercelSessionGitSource(createInput.tags.sessionId)) ||
        hasVercelSessionGitSource(createInput.sessionKey);
      const providerCreateInput = {
        ...createInput,
        // Eve replaces a session source with the template snapshot when a
        // template key is present. A selected Git source needs a fresh
        // provider create so Vercel can clone it exactly once.
        templateKey: selectedGitSource ? null : providerTemplateKey(createInput.templateKey),
      };
      try {
        const handle = await input.backend.create(providerCreateInput);
        if (!selectedGitSource) {
          return handle;
        }
        const status = await selectedCheckoutStatus(handle);
        if (status === "found") {
          return handle;
        }
        if (status === "occupied") {
          throw new Error(
            "Builder cannot restore its selected GitHub source: /workspace/repository is occupied by a non-Git directory. Review that sandbox before replacing it.",
          );
        }
        if (status !== "missing") {
          throw new Error(
            `Builder received an invalid selected-checkout inspection result: ${status}.`,
          );
        }
        const replacementKey = `app-builder-git-${createHash("sha256").update(createInput.sessionKey).digest("hex").slice(0, 40)}`;
        const current = await handle.captureState();
        if (current.metadata.sandboxName === replacementKey) {
          throw new Error(
            "Vercel reopened the selected GitHub sandbox without its checkout. The replacement also has no repository; inspect GitHub source options and provider creation logs before retrying.",
          );
        }
        await handle.stop();
        const replacement = await input.backend.create({
          ...providerCreateInput,
          // oxlint-disable-next-line sonarjs/no-undefined-assignment -- a replacement must not reopen the stale provider sandbox named in Eve's metadata.
          existingMetadata: undefined,
          sessionKey: replacementKey,
          tags: {
            ...providerCreateInput.tags,
            sessionId: providerCreateInput.tags?.sessionId ?? createInput.sessionKey,
          },
        });
        if ((await selectedCheckoutStatus(replacement)) !== "found") {
          await replacement.stop();
          throw new Error(
            "Vercel created a replacement sandbox without the selected GitHub checkout. Verify the installation's repository access and the provider Git source request, then retry this session.",
          );
        }
        return {
          captureState: async () => ({
            ...(await replacement.captureState()),
            sessionKey: createInput.sessionKey,
          }),
          session: replacement.session,
          shutdown: () => replacement.shutdown(),
          stop: () => replacement.stop(),
          useSessionFn: replacement.useSessionFn,
        } satisfies SandboxBackendHandle<SO>;
      } catch (error) {
        if (
          providerCreateInput.templateKey === null ||
          !SandboxTemplateNotProvisionedError.is(error) ||
          error.templateKey !== providerCreateInput.templateKey
        ) {
          throw error;
        }

        // Templates are an optional startup optimization. When the provider
        // has no matching template, create a fresh Vercel Sandbox directly
        // instead of blocking the user or requiring an out-of-band prewarm.
        return await input.backend.create({
          ...providerCreateInput,
          templateKey: null,
        });
      }
    },
    name: input.backend.name,
    prewarm: (prewarmInput) =>
      input.backend.prewarm({
        ...prewarmInput,
        templateKey: providerPrewarmTemplateKey(prewarmInput.templateKey),
      }),
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function createProcessSessionReusingBackend<BO, SO>(
  backend: SandboxBackend<BO, SO>,
): SandboxBackend<BO, SO> {
  const processState = globalThis as typeof globalThis & {
    __autographDevelopmentSandboxHandles?: Map<string, Promise<SandboxBackendHandle<unknown>>>;
  };
  const sessions = (processState.__autographDevelopmentSandboxHandles ??= new Map()) as Map<
    string,
    Promise<SandboxBackendHandle<SO>>
  >;
  return {
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
            sessionKey: input.sessionKey,
            state: "hit",
          }),
        );
        return existing;
      }
      console.log(
        JSON.stringify({
          event: "autograph.local.sandbox-handle",
          sessionKey: input.sessionKey,
          state: "miss",
        }),
      );

      // Promise composition preserves the shared pending handle and cleanup identity.
      // oxlint-disable promise/prefer-await-to-callbacks
      // oxlint-disable promise/prefer-await-to-then
      // oxlint-disable-next-line promise/prefer-await-to-then
      const pending: Promise<SandboxBackendHandle<SO>> = backend
        .create(input)
        .then((handle) => {
          let closed = false;
          const close = async (kind: "stop" | "shutdown") => {
            if (closed) {
              return;
            }
            closed = true;
            if (sessions.get(key) === pending) {
              sessions.delete(key);
            }
            await handle[kind]();
          };
          return {
            captureState: () => handle.captureState(),
            session: handle.session,
            shutdown: () => close("shutdown"),
            stop: () => close("stop"),
            useSessionFn: handle.useSessionFn,
          } satisfies SandboxBackendHandle<SO>;
        })
        // The backend promise cleanup must remain attached to the promise chain.
        // oxlint-disable-next-line promise/prefer-await-to-callbacks
        // oxlint-disable-next-line promise/prefer-await-to-then
        .catch((error: unknown) => {
          if (sessions.get(key) === pending) {
            sessions.delete(key);
          }
          throw error;
        });
      // oxlint-enable promise/prefer-await-to-callbacks
      // oxlint-enable promise/prefer-await-to-then
      sessions.set(key, pending);
      return pending;
    },
    name: backend.name,
    prewarm: (input) => backend.prewarm(input),
  };
}

/**
 * Keeps network authority different for the reusable template and every live
 * session. Only template construction may download the pinned toolchain.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createHostedVercelBackend(
  input: HostedVercelBackendInput,
): ReturnType<typeof vercel> {
  // Eve merges session-only creation options into the provider request,
  // although its public return type currently names only mounts. Keep the
  // compatibility assertion isolated at this boundary.
  const factory = input.factory ?? (vercel as unknown as HostedVercelBackendFactory);
  const backend = factory({
    ...(input.sandboxEnvironment === undefined ? {} : { env: { ...input.sandboxEnvironment } }),
    // The Vercel SDK otherwise uses an unbounded default transport. Keep a
    // provider outage visible to Eve and the eval runner instead of leaving a
    // session creation promise pending indefinitely.
    fetch: createProviderFetch(),
    networkPolicy: "allow-all",
    // Eve resolves this for every fresh live session, including a replacement
    // created after the provider loses the previously recorded sandbox.
    sessionCreateOptions: async (context) => {
      const source =
        context === undefined ? undefined : await resolveVercelSessionGitSource(context.session.id);
      return {
        networkPolicy: "allow-all" as const,
        ...(source === undefined
          ? {}
          : {
              // Eve forwards session-specific source options into the
              // official Vercel `Sandbox.create` call when no template is
              // present. The installation token remains provider-only.
              source: {
                password: source.token,
                ...(source.revision === undefined ? {} : { revision: source.revision }),
                type: "git" as const,
                url: source.url,
                username: "x-access-token" as const,
              },
            }),
      };
    },
  });
  const authorized = createAuthorizedSandboxBackend({
    authorizeSessionCommand: (sessionId) => assertHostedSandboxCommandAuthority({ sessionId }),
    backend: withVercelPreviewProvider(backend),
  });
  const templateOptional = createRuntimeRecoveringBackend({
    backend: authorized,
    providerTemplateKey: input.providerTemplateKey,
  });
  return (
    input.reuseProcessSessionHandles
      ? createProcessSessionReusingBackend(templateOptional)
      : templateOptional
  ) as ReturnType<typeof vercel>;
}
