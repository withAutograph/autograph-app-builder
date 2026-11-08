import { assertPrivateComputeResumeAllowed } from "./private-compute-resume";
import { APIError, DEFAULT_SANDBOX_REGION, Drive, Sandbox } from "@vercel/sandbox";
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
import { materializeVercelGitSource } from "./vercel-git-source";

const PROVIDER_RETRY_DELAY_MS = 250;
const SANDBOX_WORKSPACE = "/workspace";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
function retryableProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const { status } = error as Error & { status?: unknown };
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof status === "number" && (status === 429 || status >= 500)) {
    return true;
  }
  return /fetch failed|network|timed? ?out|econnreset|eai_again|socket/iu.test(
    `${error.message} ${error.cause instanceof Error ? error.cause.message : ""}`,
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
function providerDiagnostic(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown";
  }
  const { cause } = error as Error & { cause?: unknown };
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof cause !== "object" || cause === null || !("code" in cause)) {
    return "Vercel Sandbox request failed (provider_error)";
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  const code = typeof cause.code === "string" ? cause.code : "provider_error";
  return `Vercel Sandbox request failed (${code})`;
}

type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createProviderFetch(fetchImpl: typeof fetch = fetch): ProviderFetch {
  return async (input, init) => {
    const original = new Request(input, init);
    // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- Retry only eligible sandbox requests in their original order.
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
  readonly workspaceDrive?: WorkspaceDriveBinding;
}
interface WorkspaceDriveBinding {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  readonly region: string;
  readonly sandboxName: string;
}

const matchesWorkspaceMount = (
  native: Sandbox,
  drive: Pick<WorkspaceDriveBinding, "id" | "name">,
): boolean => {
  const mount = native.mounts?.["/workspace"];
  return mount?.mode === "read-write" && (mount.drive === drive.name || mount.drive === drive.id);
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- SDK create can reject with any throw value; reconcile only recognized ambiguous outcomes.
const ambiguousCreateFailure = (error: unknown): boolean => {
  try {
    if (!(error instanceof Error) || error.name === "AbortError") {
      return false;
    }
    if (!(error instanceof APIError)) {
      return retryableProviderFailure(error);
    }
    const { status } = error.response;
    // Vercel reports an existing named sandbox as HTTP 400 as well as 409.
    if (
      (status === 400 &&
        /sandbox with the name .+ already exists for this project/iu.test(error.message)) ||
      status === 409 ||
      status >= 500
    ) {
      return true;
    }
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
};

const shouldInitializeSeed = async (
  native: Sandbox,
  destination: string,
  preserveExisting: boolean,
): Promise<boolean> => {
  if (!preserveExisting) {
    return true;
  }
  try {
    await native.fs.lstat(destination);
    return false;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return true;
    }
    throw error;
  }
};

// Limit decoded bytes held for an upload, not the total seed tree or a file's size.
const SEED_UPLOAD_BATCH_BYTES = 8 * 1024 * 1024;

/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Preserve retained-file probes and bounded upload backpressure in source order. */
/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Preserve retained-file probes and bounded upload backpressure in source order. */
const initializeSeeds = async (input: {
  native: Sandbox;
  files: BuilderArtifact["files"];
  homePath: string;
  recovered: boolean;
}) => {
  const directories = new Set<string>();
  const initialized = new Set<string>();
  let batch: { path: string; content: Buffer }[] = [];
  let bytes = 0;
  let transferredFiles = 0;
  const flush = async () => {
    if (batch.length === 0) {
      return;
    }
    await input.native.writeFiles(batch, {});
    transferredFiles += batch.length;
    console.info(JSON.stringify({ event: "autograph.sandbox.seed-transfer", transferredFiles }));
    batch = [];
    bytes = 0;
  };
  // oxlint-disable-next-line sonarjs/too-many-break-or-continue-in-loop -- Seed workspace files sequentially with first-seed-wins behavior.
  for (const file of input.files) {
    const destination = path.posix.resolve(
      SANDBOX_WORKSPACE,
      file.path.replace(/^\$HOME(?=\/|$)/u, input.homePath),
    );
    const preserveExisting =
      input.recovered || destination === SANDBOX_WORKSPACE || destination.startsWith("/workspace/");
    // Preserve the original sequential first-seed-wins behavior for retained paths.
    if (preserveExisting && initialized.has(destination)) {
      continue;
    }
    if (!(await shouldInitializeSeed(input.native, destination, preserveExisting))) {
      continue;
    }
    const content = Buffer.from(file.content, "base64");
    if (bytes + content.byteLength > SEED_UPLOAD_BATCH_BYTES) {
      await flush();
    }
    const directory = path.posix.dirname(destination);
    if (!directories.has(directory)) {
      await input.native.fs.mkdir(directory, { recursive: true });
      directories.add(directory);
    }
    batch.push({ content, path: destination });
    initialized.add(destination);
    bytes += content.byteLength;
    if (bytes >= SEED_UPLOAD_BATCH_BYTES) {
      await flush();
    }
  }
  await flush();
};
/* oxlint-enable eslint/no-await-in-loop, react-doctor/async-await-in-loop */
/* oxlint-enable eslint/no-await-in-loop, react-doctor/async-await-in-loop */

export const createBuilderVercelProvider = (
  options?: BuilderVercelEnvironmentOptions,
): SandboxProviderImplementation<
  undefined,
  BuilderArtifact,
  BuilderSessionState,
  BuilderSandboxSession
> => {
  const transport = { fetch: createProviderFetch() };
  const createOrRecoverSandbox = async (input: {
    create: () => Promise<Sandbox>;
    name: string;
    drive: Drive;
  }) => {
    try {
      return { native: await input.create(), recovered: false };
    } catch (error) {
      if (!ambiguousCreateFailure(error)) {
        throw error;
      }
      try {
        // Use the same project-scoped OIDC credentials as Drive.getOrCreate.
        // Passing only projectId makes the SDK treat credentials as incomplete.
        const native = await Sandbox.get({
          ...transport,
          name: input.name,
          resume: false,
        });
        const sameTarget = native.name === input.name && native.region === input.drive.region;
        const owned = native.persistent && sameTarget;
        if (
          !owned ||
          !matchesWorkspaceMount(native, { id: input.drive.driveId, name: input.drive.name })
        ) {
          throw error;
        }
        if (native.status === "running") {
          return { native, recovered: true };
        }
        await assertPrivateComputeResumeAllowed(native, () => {
          // The enclosing SDK/name/Drive checks establish this reconciled provider handle.
        });
        const resumed = await Sandbox.get({
          ...transport,
          name: input.name,
          resume: true,
        });
        if (
          resumed.name !== input.name ||
          resumed.region !== input.drive.region ||
          !resumed.persistent ||
          !matchesWorkspaceMount(resumed, { id: input.drive.driveId, name: input.drive.name })
        ) {
          throw error;
        }
        return { native: resumed, recovered: true };
      } catch {
        // A failed or foreign lookup never authorizes cleanup or hides create's failure.
        throw error;
      }
    }
  };
  const deleteWorkspaceDrive = async (binding: WorkspaceDriveBinding, signal?: AbortSignal) => {
    // The SDK has no get-only Drive method. Listing never creates a missing drive.
    const drives = await Drive.list({
      ...transport,
      namePrefix: binding.name,
      projectId: binding.projectId,
      sortBy: "name",
      signal,
    });
    for await (const drive of drives) {
      if (drive.driveId !== binding.id && drive.name !== binding.name) {
        continue;
      }
      if (
        drive.driveId === binding.id &&
        drive.name === binding.name &&
        drive.projectId === binding.projectId &&
        drive.region === binding.region
      ) {
        if (drive.currentSandboxName !== undefined || drive.currentSessionId !== undefined) {
          throw new Error(
            "Builder workspace storage cleanup is incomplete because the drive is still attached. Retry this session deletion.",
          );
        }
        // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Delete only this exact detached owned drive, then end enumeration.
        await drive.delete({ signal });
        return;
      }
      throw new Error(
        "Builder workspace storage cleanup could not verify the saved drive identity. The drive was retained.",
      );
    }
  };
  // oxlint-disable-next-line unicorn/consistent-function-scoping -- Keep native handle lifecycle next to its provider environment.
  const handle = (
    native: Sandbox,
    sessionId: string,
    workspaceDrive?: WorkspaceDriveBinding,
  ): SandboxProviderHandle<BuilderSandboxSession> => {
    const registration = registerVercelPreviewProvider(native.name, native);
    let deletedSandbox: Sandbox | undefined;
    const close = async (operation: "stop" | "delete", signal?: AbortSignal) => {
      try {
        const current = await registration.currentForCleanup(operation === "delete");
        if (current === undefined) {
          return;
        }
        const ownsDrive =
          workspaceDrive !== undefined &&
          current.name === workspaceDrive.sandboxName &&
          matchesWorkspaceMount(current, workspaceDrive);
        if (operation !== "delete" || deletedSandbox !== current) {
          await current[operation]({ signal });
        }
        if (operation === "delete") {
          deletedSandbox = current;
          if (ownsDrive) {
            await deleteWorkspaceDrive(workspaceDrive, signal);
          } else if (workspaceDrive !== undefined) {
            throw new Error(
              "Builder workspace storage cleanup could not verify the saved attachment. The drive was retained; retry this session deletion.",
            );
          }
        }
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
        session: createVercelSdkSession(
          native,
          () => registration.current,
          async () => {
            await assertHostedSandboxCommandAuthority({ sessionId });
          },
          options?.sandboxEnvironment,
        ),
      }),
    };
  };
  return {
    prepare(context) {
      // Only public resource targets are persisted. Preparation does not contact
      // Vercel or freeze live repository bytes into a provider snapshot.
      const files: SandboxProviderTargetFile[] = [];
      for (const tree of [context.resources.workspace, context.resources.skills]) {
        if (tree === undefined) {
          continue;
        }
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
      const current = await Sandbox.get({ ...transport, name: state.name, resume: false });
      if (current.status === "running") {
        return handle(current, context.session.id, state.workspaceDrive);
      }
      await assertPrivateComputeResumeAllowed(current, async () => {
        await assertHostedSandboxCommandAuthority({ sessionId: context.session.id });
      });
      const native = await Sandbox.get({ ...transport, name: state.name, resume: true });
      return handle(native, context.session.id, state.workspaceDrive);
    },
    async start(context, _liveOptions, artifact) {
      const source = await resolveVercelSessionGitSource(context.session.id);
      const name = `app-builder-${createHash("sha256").update(context.session.id).digest("hex").slice(0, 40)}`;
      const driveName = `${name}-workspace`;
      const drive = await Drive.getOrCreate({
        ...transport,
        name: driveName,
        region: DEFAULT_SANDBOX_REGION,
      });
      if (
        drive.name !== driveName ||
        (drive.currentSandboxName !== undefined && drive.currentSandboxName !== name)
      ) {
        throw new Error("The Builder workspace drive belongs to another sandbox.");
      }
      const { native, recovered } = await createOrRecoverSandbox({
        name,
        drive,
        create: async () =>
          await Sandbox.create({
            ...transport,
            image: "vcr.vercel.com/vercel/eve/base:0.68.0",
            name,
            networkPolicy: "allow-all",
            persistent: true,
            region: DEFAULT_SANDBOX_REGION,
            mounts: { "/workspace": drive },
            // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
            ...(options?.sandboxEnvironment === undefined
              ? {}
              : { env: { ...options.sandboxEnvironment } }),
          }),
      });
      const workspaceDrive: WorkspaceDriveBinding = {
        id: drive.driveId,
        name: drive.name,
        projectId: drive.projectId,
        region: drive.region,
        sandboxName: native.name,
      };
      try {
        await native.fs.mkdir(SANDBOX_WORKSPACE, { recursive: true });
        const home = await native.runCommand({ args: ["HOME"], cmd: "printenv" });
        if (home.exitCode !== 0) {
          throw new Error("Vercel Sandbox did not expose its managed home directory.");
        }
        const homeOutput = await home.stdout();
        const homePath = homeOutput.trim();
        await initializeSeeds({ native, files: artifact.files, homePath, recovered });
        // Last initialization step: source stays on the mounted filesystem and
        // a retry can recognize its completed checkout without rewriting edits.
        if (source !== undefined) {
          await materializeVercelGitSource({
            current: () => native,
            source,
            reuseOwnedCheckout: true,
          });
        }
        return {
          handle: handle(native, context.session.id, workspaceDrive),
          state: { name: native.name, version: 1 as const, workspaceDrive },
        };
      } catch (error) {
        if (!recovered) {
          try {
            await native.delete();
          } catch {
            // Retain the initiating setup failure; provider cleanup may also fail.
          }
        }
        // Never delete the Drive on partial start: its creation/attachment may
        // have completed earlier, and a retry must retain the same working bytes.
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
