import path from "node:path";
import { createHash } from "node:crypto";
import { APIError, Sandbox } from "@vercel/sandbox";
import { getVercelOidcToken } from "@vercel/oidc";
import { z } from "zod";
import type { hostedOperatorSandboxConfigurationSchema } from "../provisioning/hosted-operator-source-configuration";
import { hostedOperatorSandboxSourceOptions } from "../provisioning/hosted-operator-sandbox-source";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";

import { managedRuntimeWorkerAssetSchema } from "../provisioning/hosted-operator-continuity-contract";
import type { ManagedRuntimeWorkerAssetState } from "../provisioning/hosted-operator-continuity-contract";

export { managedRuntimeWorkerAssetSchema } from "../provisioning/hosted-operator-continuity-contract";
export type { ManagedRuntimeWorkerAssetState } from "../provisioning/hosted-operator-continuity-contract";

const descriptorSchema = z.strictObject({
  id: z.string().min(1),
  executablePath: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  operationScope: z.literal("managed-app-runtime-v1"),
  subcommand: z.literal("protected-managed-app-runtime"),
});
export type ManagedRuntimeWorkerAssetDescriptor = z.infer<typeof descriptorSchema>;
export type ManagedRuntimeWorkerAssetSource = Pick<
  Sandbox,
  "name" | "readFileToBuffer" | "delete"
> & { stop: () => Promise<void> };
const sourcePort = (sandbox: Sandbox): ManagedRuntimeWorkerAssetSource => ({
  name: sandbox.name,
  readFileToBuffer: (...args) => sandbox.readFileToBuffer(...args),
  stop: async () => {
    await sandbox.stop();
  },
  delete: (...args) => sandbox.delete(...args),
});
export type ManagedRuntimeWorkerAssetTarget = Pick<Sandbox, "writeFiles" | "readFileToBuffer"> & {
  fs: Pick<Sandbox["fs"], "mkdir">;
};
const sourceFields = { projectId: z.string().min(1), teamId: z.string().min(1) };
const sourceConfigurationSchema = z.union([
  z.object({ ...sourceFields, image: z.string().min(1), source: z.never().optional() }),
  z.object({
    ...sourceFields,
    source: z.strictObject({ type: z.literal("snapshot"), snapshotId: z.string().min(1) }),
    image: z.never().optional(),
  }),
]);
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const unavailable = () => new HostedOperatorError("reconciliation_required");

const deleteOwnedSource = async (source: ManagedRuntimeWorkerAssetSource) => {
  try {
    await source.stop();
  } catch {
    /* Exact owned deletion below remains authoritative cleanup. */
  }
  try {
    await source.delete({ deleteOrphanSnapshots: false });
  } catch (error) {
    // This exact owned handle's SDK404 proves current absence.
    if (!(error instanceof APIError && error.response.status === 404)) {
      throw error;
    }
  }
};

const requiredSource = (source: ManagedRuntimeWorkerAssetSource | undefined) => {
  if (source === undefined) {
    throw unavailable();
  }
  return source;
};

export interface ManagedRuntimeWorkerAssetDisposeInput {
  attemptId: string;
  state?: ManagedRuntimeWorkerAssetState;
  checkpoint: (state: ManagedRuntimeWorkerAssetState) => Promise<void>;
}
const ownedSourceState = (
  input: Pick<ManagedRuntimeWorkerAssetDisposeInput, "attemptId" | "state">,
) => {
  const attemptId = z.uuid().parse(input.attemptId);
  const name = `managed-runtime-asset-${attemptId}`;
  const state = managedRuntimeWorkerAssetSchema.parse(input.state ?? {});
  if (
    state.sourceSandboxId !== undefined &&
    (state.sourceSandboxId !== name || state.sourceCreationAttempted !== true)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  return { attemptId, name, state };
};

/** Materialize only a configured worker asset. Incoming Builder workload credentials are not an input. */
export const createManagedRuntimeWorkerAsset = (dependencies: {
  configuration: z.input<typeof hostedOperatorSandboxConfigurationSchema>;
  /** Native operator-host OIDC acquisition; injectable only for controlled SDK fixtures. */
  token?: typeof getVercelOidcToken;
  create?: (
    options: Parameters<typeof Sandbox.create>[0],
  ) => Promise<ManagedRuntimeWorkerAssetSource>;
  get?: (options: Parameters<typeof Sandbox.get>[0]) => Promise<ManagedRuntimeWorkerAssetSource>;
}) => {
  // The configuration import is type-only; the pure continuity contract owns the state schema.
  const configuration = sourceConfigurationSchema.parse(dependencies.configuration);
  const create =
    dependencies.create ?? (async (options) => sourcePort(await Sandbox.create(options)));
  const get = dependencies.get ?? (async (options) => sourcePort(await Sandbox.get(options)));
  const credentials = async () => ({
    projectId: configuration.projectId,
    teamId: configuration.teamId,
    token: await (dependencies.token ?? getVercelOidcToken)({
      project: configuration.projectId,
      team: configuration.teamId,
    }),
  });
  const dispose = async (
    input: ManagedRuntimeWorkerAssetDisposeInput,
    retained?: ManagedRuntimeWorkerAssetSource,
  ) => {
    const owned = ownedSourceState(input);
    const { name } = owned;
    let { state } = owned;
    let source = retained;
    const save = async (next: ManagedRuntimeWorkerAssetState) => {
      await input.checkpoint(next);
      state = managedRuntimeWorkerAssetSchema.parse(next);
    };
    if (state.sourceCreationAttempted === true && state.disposed !== true && source === undefined) {
      try {
        const observed = await get({
          name: state.sourceSandboxId ?? name,
          resume: false,
          ...(await credentials()),
        });
        if (observed.name !== name) {
          throw unavailable();
        }
        source = observed;
      } catch (error) {
        if (
          error instanceof APIError &&
          error.response.status === 404 &&
          state.sourceSandboxId === name
        ) {
          await save({ ...state, disposed: true });
        } else {
          throw error;
        }
      }
    }
    if (source !== undefined) {
      // Keep its discovered locator for a later exact404 if deletion's response is lost.
      try {
        await save({ ...state, sourceSandboxId: name });
      } catch {
        /* Closing this already-owned handle still takes priority. */
      }
      await deleteOwnedSource(source);
      await save({ ...state, sourceSandboxId: name, disposed: true });
    } else if (state.sourceCreationAttempted !== true) {
      await save({ ...state, disposed: true });
    }
  };
  return {
    async dispose(input: ManagedRuntimeWorkerAssetDisposeInput): Promise<void> {
      try {
        await dispose(input);
      } catch (error) {
        throw error instanceof HostedOperatorError ? error : unavailable();
      }
    },
    async install(input: {
      target: ManagedRuntimeWorkerAssetTarget;
      descriptor: ManagedRuntimeWorkerAssetDescriptor;
      attemptId: string;
      state?: ManagedRuntimeWorkerAssetState;
      assertCurrent: () => Promise<void>;
      checkpoint: (state: ManagedRuntimeWorkerAssetState) => Promise<void>;
    }): Promise<void> {
      const descriptor = descriptorSchema.parse(input.descriptor);
      const owned = ownedSourceState(input);
      const { attemptId, name } = owned;
      let state = owned.state;
      let source: ManagedRuntimeWorkerAssetSource | undefined;
      let failure: { error: unknown } | undefined;
      const save = async (next: ManagedRuntimeWorkerAssetState) => {
        await input.checkpoint(next);
        state = managedRuntimeWorkerAssetSchema.parse(next);
      };
      const reconnect = async () => {
        const observed = await get({
          name: state.sourceSandboxId ?? name,
          resume: false,
          ...(await credentials()),
        });
        if (observed.name !== name) {
          throw unavailable();
        }
        source = observed;
      };
      try {
        await input.assertCurrent();
        let bytes = await input.target.readFileToBuffer({ path: descriptor.executablePath });
        await input.assertCurrent();
        if (bytes === null || digest(bytes) !== descriptor.sha256) {
          if (state.sourceCreationAttempted === true && state.disposed !== true) {
            await reconnect();
          } else {
            const access = await credentials();
            await input.assertCurrent();
            await save({ sourceCreationAttempted: true, installed: false, disposed: false });
            // Durable dispatch precedes create. Unknown creates reconnect by the exact SDK-owned name only.
            await input.assertCurrent();
            const created = await create({
              ...hostedOperatorSandboxSourceOptions(configuration),
              ...access,
              name,
              persistent: false,
              env: {},
              ports: [],
              networkPolicy: "allow-all",
              timeout: 300_000,
            });
            if (created.name !== name) {
              throw unavailable();
            }
            source = created;
          }
          await save({ ...state, sourceSandboxId: requiredSource(source).name });
          await input.assertCurrent();
          bytes = await requiredSource(source).readFileToBuffer({
            path: descriptor.executablePath,
          });
          await input.assertCurrent();
          if (bytes === null || digest(bytes) !== descriptor.sha256) {
            throw new HostedOperatorError("resource_mismatch");
          }
        }
        await input.assertCurrent();
        await input.target.fs.mkdir(path.posix.dirname(descriptor.executablePath), {
          recursive: true,
        });
        await input.assertCurrent();
        await input.target.writeFiles([
          { path: descriptor.executablePath, content: bytes, mode: 0o755 },
        ]);
        await input.assertCurrent();
        const installed = await input.target.readFileToBuffer({ path: descriptor.executablePath });
        await input.assertCurrent();
        if (installed === null || digest(installed) !== descriptor.sha256) {
          throw unavailable();
        }
        await save({ ...state, installed: true });
      } catch (error) {
        failure = { error };
      } finally {
        try {
          await dispose({ attemptId, state, checkpoint: input.checkpoint }, source);
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure !== undefined) {
        throw failure.error instanceof HostedOperatorError ? failure.error : unavailable();
      }
    },
  };
};
