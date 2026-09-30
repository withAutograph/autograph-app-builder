import { Sandbox } from "@vercel/sandbox";
import type {
  SandboxProviderHandle,
  SandboxProviderTargetFile,
  SandboxProviderImplementation,
} from "eve/sandbox/provider";
import { defineSandboxProvider } from "eve/sandbox/provider";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import type { BuilderSandboxSession } from "./builder-sandbox";
import { assertHostedSandboxCommandAuthority } from "./deployment-execution-lease";
import { createAuthorizedSandboxSession } from "./sandbox-command-adapter";
import { resolveVercelSessionGitSource } from "./vercel-session-source";
import { registerVercelPreviewProvider } from "./vercel-preview-provider";
import { createVercelSdkSession } from "./vercel-sdk-session";

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

export interface BuilderVercelEnvironmentOptions {
  readonly sandboxEnvironment?: Readonly<Record<string, string>>;
}

// oxlint-disable-next-line typescript/consistent-type-definitions -- Eve JSON artifacts require the implicit index signature of an object type alias.
type BuilderArtifact = {
  readonly files: readonly { readonly path: string; readonly content: string }[];
};
interface BuilderSessionState {
  readonly name: string;
  readonly version: 1;
}

export const createBuilderVercelProvider = (
  options?: BuilderVercelEnvironmentOptions,
): SandboxProviderImplementation<
  undefined,
  BuilderArtifact,
  BuilderSessionState,
  BuilderSandboxSession
> => {
  const transport = { fetch: createProviderFetch() };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep native handle lifecycle next to its provider environment.
  const handle = (
    native: Sandbox,
    sessionId: string,
  ): SandboxProviderHandle<BuilderSandboxSession> => {
    const registration = registerVercelPreviewProvider(native.name, native);
    const close = async (operation: "stop" | "delete", signal?: AbortSignal) => {
      try {
        const current = await registration.currentForCleanup(operation === "delete");
        await current?.[operation]({ signal });
      } finally {
        registration.unregister();
      }
    };
    return {
      onRuntimeShutdown: () => close("stop"),
      onSessionDelete: (input) => close("delete", input?.abortSignal),
      onSessionStop: () => close("stop"),
      sandbox: createAuthorizedSandboxSession({
        authorize: () => assertHostedSandboxCommandAuthority({ sessionId }),
        session: createVercelSdkSession(native, () => registration.current),
      }),
    };
  };
  return {
    prepare(context) {
      // Only public resource targets are persisted. Preparation does not contact
      // Vercel or freeze live repository bytes into a provider snapshot.
      const files: SandboxProviderTargetFile[] = [];
      for (const tree of [context.resources.workspace, context.resources.skills]) {
        if (tree === undefined) continue;
        for (const file of tree.files) {
          files.push({
            content: file.content,
            path: path.posix.join(tree.targetPath, file.relativePath),
          });
        }
      }
      return Promise.resolve({
        files: files.map((file) => ({
          content: Buffer.from(file.content).toString("base64"),
          path: file.path,
        })),
      });
    },
    async resume(context, _artifact, state) {
      // Reconnect only: do not recreate source selection or initialization.
      const native = await Sandbox.get({ ...transport, name: state.name, resume: true });
      return handle(native, context.session.id);
    },
    async start(context, _liveOptions, artifact) {
      const source = await resolveVercelSessionGitSource(context.session.id);
      const name = `app-builder-${createHash("sha256").update(context.session.id).digest("hex").slice(0, 40)}`;
      const native = await Sandbox.create({
        ...transport,
        image: "vcr.vercel.com/vercel/eve/base:0.68.0",
        name,
        networkPolicy: "allow-all",
        persistent: true,
        ...(options?.sandboxEnvironment === undefined
          ? {}
          : { env: { ...options.sandboxEnvironment } }),
        ...(source === undefined
          ? {}
          : {
              source: {
                password: source.token,
                type: "git" as const,
                url: source.url,
                username: "x-access-token",
                ...(source.revision === undefined ? {} : { revision: source.revision }),
              },
            }),
      });
      try {
        await native.fs.mkdir("/workspace", { recursive: true });
        const home = await native.runCommand({ args: ["HOME"], cmd: "printenv" });
        if (home.exitCode !== 0)
          throw new Error("Vercel Sandbox did not expose its managed home directory.");
        const homeOutput = await home.stdout();
        const homePath = homeOutput.trim();
        const sandbox = createVercelSdkSession(native);
        for (const file of artifact.files) {
          // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Sequential resource uploads keep provider backpressure for the complete tree.
          await sandbox.writeBinaryFile({
            content: Buffer.from(file.content, "base64"),
            path: file.path.replace(/^\$HOME(?=\/|$)/u, homePath),
          });
        }
        return {
          handle: handle(native, context.session.id),
          state: { name: native.name, version: 1 as const },
        };
      } catch (error) {
        try {
          await native.delete();
        } catch {
          // Retain the initiating setup failure; provider cleanup may also fail.
        }
        throw error;
      }
    },
  };
};

/** Session-specific Git sources and preview identity are application provider concerns. */
export const BuilderVercelSandbox = defineSandboxProvider<
  BuilderVercelEnvironmentOptions,
  undefined,
  BuilderArtifact,
  BuilderSessionState,
  BuilderSandboxSession
>({ environment: createBuilderVercelProvider, name: "autograph-vercel" });

export const createHostedVercelEnvironment = (input: BuilderVercelEnvironmentOptions = {}) =>
  BuilderVercelSandbox.environment(input);
