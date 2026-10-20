/* oxlint-disable eslint/require-await -- SDK ports are controlled asynchronous filesystem and lifecycle fixtures, never provider calls. */
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { APIError } from "@vercel/sandbox";
import type { Sandbox } from "@vercel/sandbox";
import { expect, it } from "vitest";
import {
  createManagedRuntimeWorkerAsset,
  managedRuntimeWorkerAssetSchema,
} from "./managed-runtime-worker-asset";
import type {
  ManagedRuntimeWorkerAssetState,
  ManagedRuntimeWorkerAssetTarget,
  ManagedRuntimeWorkerAssetSource,
} from "./managed-runtime-worker-asset";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";

const binary = Buffer.from([0, 255, 128, 1, 10, 13, 0, 240, 159, 140, 179]);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const descriptor = {
  id: "managed-app-runtime-v1",
  executablePath: "/opt/autograph/workers/managed-runtime",
  sha256: sha(binary),
  operationScope: "managed-app-runtime-v1",
  subcommand: "protected-managed-app-runtime",
} as const;
const worker = {
  id: "fixture-installer",
  executablePath: "/opt/workers/installer",
  sha256: "a".repeat(64),
  operationScope: "generated-app-release-install-v1",
  subcommand: "protected-generated-app-install",
} as const;
const fields = {
  projectId: "operator-project",
  teamId: "operator-team",
  accessWorker: worker,
  authWorker: worker,
  resourcesWorker: worker,
  authProposal: { id: "proposal", executablePath: "/opt/workers/proposal", sha256: "b".repeat(64) },
  workers: { fixture: worker },
};
interface AssetFixtureFaults {
  sourceBytes: Buffer | null;
  createUnknown: boolean;
  createAccepted: boolean;
  getUnknown: boolean;
  deleteUnknown: boolean;
  deleteAccepted: boolean;
  deleteNotFound: boolean;
  writeUnknown: boolean;
  badReadback: boolean;
  checkpointFailure: boolean;
  tokenFailure: boolean;
  revokeAfterSourceRead: boolean;
  wrongName: boolean;
  stopFailure: boolean;
}
const fixture = (image = false) => {
  const attemptId = randomUUID();
  const name = `managed-runtime-asset-${attemptId}`;
  let state: ManagedRuntimeWorkerAssetState = {};
  let targetBytes: Buffer | null = null;
  let exists = false;
  let denied = false;
  const faults: AssetFixtureFaults = {
    sourceBytes: Buffer.from(binary),
    createUnknown: false,
    createAccepted: true,
    getUnknown: false,
    deleteUnknown: false,
    deleteAccepted: true,
    deleteNotFound: false,
    writeUnknown: false,
    badReadback: false,
    checkpointFailure: false,
    tokenFailure: false,
    revokeAfterSourceRead: false,
    wrongName: false,
    stopFailure: false,
  };
  const stats = { creates: 0, gets: 0, stops: 0, deletes: 0, writes: 0, reads: 0, tokens: 0 };
  const checkpoints: ManagedRuntimeWorkerAssetState[] = [];
  const createOptions: Parameters<typeof Sandbox.create>[0][] = [];
  const getOptions: Parameters<typeof Sandbox.get>[0][] = [];
  const directories = new Set<string>();
  const target: ManagedRuntimeWorkerAssetTarget = {
    fs: {
      async mkdir(directory, options) {
        expect(directory).toBe(path.posix.dirname(descriptor.executablePath));
        expect(options).toEqual({ recursive: true });
        directories.add(directory);
        return directory;
      },
    },
    async readFileToBuffer(input) {
      expect(input.path).toBe(descriptor.executablePath);
      stats.reads += 1;
      return targetBytes === null ? null : Buffer.from(targetBytes);
    },
    async writeFiles(files) {
      stats.writes += 1;
      expect(files).toHaveLength(1);
      const [file] = files;
      if (file === undefined) {
        throw new Error("Missing target file");
      }
      expect(file.path).toBe(descriptor.executablePath);
      expect(directories.has(path.posix.dirname(file.path))).toBe(true);
      expect(file.mode).toBe(0o755);
      expect(Buffer.isBuffer(file.content)).toBe(true);
      targetBytes = faults.badReadback ? Buffer.from("wrong") : Buffer.from(file.content);
      if (faults.writeUnknown) {
        // oxlint-disable-next-line eslint/prefer-promise-reject-errors -- An SDK promise can reject without an Error; the boundary must still fail closed.
        await Promise.reject();
      }
    },
  };
  const source: ManagedRuntimeWorkerAssetSource = {
    get name() {
      return faults.wrongName ? "unrelated-source" : name;
    },
    async readFileToBuffer(input) {
      expect(input.path).toBe(descriptor.executablePath);
      if (faults.revokeAfterSourceRead) {
        denied = true;
      }
      return faults.sourceBytes;
    },
    async stop() {
      stats.stops += 1;
      if (faults.stopFailure) {
        throw new Error("Stop result unknown");
      }
    },
    async delete(options) {
      stats.deletes += 1;
      expect(options?.deleteOrphanSnapshots).toBe(false);
      if (faults.deleteAccepted) {
        exists = false;
      }
      if (faults.deleteUnknown) {
        throw new Error("Owned delete result unknown");
      }
      if (faults.deleteNotFound) {
        throw new APIError(new Response(null, { status: 404 }));
      }
    },
  };
  const helper = createManagedRuntimeWorkerAsset({
    configuration: image
      ? { ...fields, image: "operator-workers@sha256:fixture" }
      : { ...fields, source: { type: "snapshot", snapshotId: "snap_operator_workers" } },
    token: async (options) => {
      stats.tokens += 1;
      expect(options).toEqual({ project: fields.projectId, team: fields.teamId });
      if (faults.tokenFailure) {
        throw new Error("Native host OIDC unavailable");
      }
      return "native-operator-host-oidc";
    },
    create: async (options) => {
      expect(state.sourceCreationAttempted).toBe(true);
      expect(state.disposed).toBe(false);
      stats.creates += 1;
      createOptions.push(options);
      exists = faults.createAccepted;
      if (faults.createUnknown) {
        throw new Error("Owned source create result unknown");
      }
      return source;
    },
    get: async (options) => {
      stats.gets += 1;
      getOptions.push(options);
      expect(options.name).toBe(name);
      expect(options.resume).toBe(false);
      expect(options).toMatchObject({
        projectId: fields.projectId,
        teamId: fields.teamId,
        token: "native-operator-host-oidc",
      });
      if (faults.getUnknown) {
        throw new Error("Source readback unavailable");
      }
      if (!exists) {
        throw new APIError(new Response(null, { status: 404 }));
      }
      return source;
    },
  });
  return {
    attemptId,
    name,
    stats,
    faults,
    checkpoints,
    createOptions,
    getOptions,
    get state() {
      return state;
    },
    setState(value: ManagedRuntimeWorkerAssetState) {
      state = managedRuntimeWorkerAssetSchema.parse(value);
    },
    setTarget(value: Buffer | null) {
      targetBytes = value;
    },
    get targetBytes() {
      return targetBytes;
    },
    retain() {
      exists = true;
      state = { sourceCreationAttempted: true, sourceSandboxId: name, disposed: false };
    },
    dispose: () =>
      helper.dispose({
        attemptId,
        state,
        checkpoint: async (next) => {
          if (faults.checkpointFailure) {
            throw new Error("Durable cleanup checkpoint unavailable");
          }
          state = managedRuntimeWorkerAssetSchema.parse(next);
          checkpoints.push(structuredClone(state));
        },
      }),
    install: () =>
      helper.install({
        target,
        descriptor,
        attemptId,
        state,
        assertCurrent: async () => {
          if (denied) {
            throw new HostedOperatorError("authorization_required");
          }
        },
        checkpoint: async (next) => {
          if (faults.checkpointFailure) {
            throw new Error("Durable checkpoint unavailable");
          }
          state = managedRuntimeWorkerAssetSchema.parse(next);
          checkpoints.push(structuredClone(state));
        },
      }),
  };
};

it.each([false, true])(
  "transfers exact opaque bytes with executable mode from configured source (%s), native host credentials only",
  async (image) => {
    const f = fixture(image);
    await f.install();
    expect(f.targetBytes).toEqual(binary);
    expect(f.state).toMatchObject({
      sourceCreationAttempted: true,
      sourceSandboxId: f.name,
      installed: true,
      disposed: true,
    });
    expect(f.stats.creates).toBe(1);
    expect(f.stats.stops).toBe(1);
    expect(f.stats.deletes).toBe(1);
    expect(f.createOptions[0]).toMatchObject({
      name: f.name,
      projectId: fields.projectId,
      teamId: fields.teamId,
      token: "native-operator-host-oidc",
      persistent: false,
      env: {},
      ports: [],
      networkPolicy: "allow-all",
    });
    if (image) {
      expect(f.createOptions[0]).toHaveProperty("image", "operator-workers@sha256:fixture");
      expect(f.createOptions[0]).not.toHaveProperty("source");
    } else {
      expect(f.createOptions[0]).toHaveProperty("source", {
        type: "snapshot",
        snapshotId: "snap_operator_workers",
      });
      expect(f.createOptions[0]).not.toHaveProperty("image");
    }
    const metadata = JSON.stringify(f.checkpoints);
    expect(metadata).not.toContain("native-operator-host-oidc");
    expect(metadata).not.toContain(binary.toString("base64"));
  },
);

it("reads the target first, restores executable mode and avoids a source VM when exact bytes already exist", async () => {
  const f = fixture();
  f.setTarget(binary);
  await f.install();
  expect(f.stats.creates).toBe(0);
  expect(f.stats.tokens).toBe(0);
  expect(f.stats.writes).toBe(1);
  expect(f.state).toEqual({ installed: true, disposed: true });
});

it.each(["wrong", "missing"])(
  "rejects %s source bytes before target write and disposes only the owned source",
  async (kind) => {
    const f = fixture();
    f.faults.sourceBytes = kind === "missing" ? null : Buffer.from("wrong");
    await expect(f.install()).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.stats.writes).toBe(0);
    expect(f.stats.stops).toBe(1);
    expect(f.stats.deletes).toBe(1);
    expect(f.state.disposed).toBe(true);
  },
);

it.each(["writeUnknown", "badReadback"] as const)(
  "cleans up when target %s and never marks installation verified",
  async (fault) => {
    const f = fixture();
    f.faults[fault] = true;
    await expect(f.install()).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.state.installed).not.toBe(true);
    expect(f.state.disposed).toBe(true);
    expect(f.stats.deletes).toBe(1);
  },
);

it("requires the durable source-create marker before any create and does not mark dispatch on token failure", async () => {
  const f = fixture();
  f.faults.checkpointFailure = true;
  await expect(f.install()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.stats.creates).toBe(0);
  expect(f.stats.gets).toBe(0);
  const g = fixture();
  g.faults.tokenFailure = true;
  await expect(g.install()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(g.state.sourceCreationAttempted).not.toBe(true);
  expect(g.stats.creates).toBe(0);
});

it("never recreates an unknown source create without a locator; it only reads its deterministic name", async () => {
  const f = fixture();
  f.faults.createUnknown = true;
  f.faults.createAccepted = false;
  await expect(f.install()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.state.sourceCreationAttempted).toBe(true);
  expect(f.state.sourceSandboxId).toBeUndefined();
  await expect(f.install()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.stats.creates).toBe(1);
  expect(f.stats.gets).toBeGreaterThan(0);
  expect(f.stats.writes).toBe(0);
  expect(f.state.disposed).not.toBe(true);
});

it("reconnects a retained owned source before reading and never creates another VM", async () => {
  const f = fixture();
  f.retain();
  await f.install();
  expect(f.stats.creates).toBe(0);
  expect(f.stats.gets).toBe(1);
  expect(f.targetBytes).toEqual(binary);
  expect(f.state.disposed).toBe(true);
});

it("retains unknown cleanup then settles only exact known-source SDK404 without recreating", async () => {
  const f = fixture();
  f.faults.deleteUnknown = true;
  await expect(f.install()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.state).toMatchObject({ installed: true, disposed: false, sourceSandboxId: f.name });
  await f.install();
  expect(f.state.disposed).toBe(true);
  expect(f.stats.creates).toBe(1);
  expect(f.stats.deletes).toBe(1);
});

it("retries cleanup of the same owned source after a negative delete result and a fresh named read", async () => {
  const f = fixture();
  f.faults.deleteUnknown = true;
  f.faults.deleteAccepted = false;
  await expect(f.install()).rejects.toMatchObject({ code: "reconciliation_required" });
  f.faults.deleteUnknown = false;
  f.faults.deleteAccepted = true;
  await f.install();
  expect(f.state.disposed).toBe(true);
  expect(f.stats.creates).toBe(1);
  expect(f.stats.gets).toBe(1);
  expect(f.stats.deletes).toBe(2);
});

it("disposes the owned source after owner revocation without writing the target", async () => {
  const f = fixture();
  f.faults.revokeAfterSourceRead = true;
  await expect(f.install()).rejects.toMatchObject({ code: "authorization_required" });
  expect(f.stats.writes).toBe(0);
  expect(f.stats.deletes).toBe(1);
  expect(f.state.disposed).toBe(true);
});

it("refuses another source locator or mismatched SDK name without touching that resource", async () => {
  const f = fixture();
  f.setState({ sourceCreationAttempted: true, sourceSandboxId: "foreign-source" });
  await expect(f.install()).rejects.toMatchObject({ code: "resource_mismatch" });
  expect(f.stats.gets).toBe(0);
  expect(f.stats.deletes).toBe(0);
  const g = fixture();
  g.retain();
  g.faults.wrongName = true;
  await expect(g.install()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(g.stats.writes).toBe(0);
  expect(g.stats.stops).toBe(0);
  expect(g.stats.deletes).toBe(0);
});

it("accepts authoritative owned deletion after stop uncertainty and repairs again only after confirmed disposal", async () => {
  const f = fixture();
  f.faults.stopFailure = true;
  await f.install();
  expect(f.state.disposed).toBe(true);
  f.setTarget(null);
  await f.install();
  expect(f.stats.creates).toBe(2);
  expect(f.targetBytes).toEqual(binary);
  expect(f.state).toMatchObject({ installed: true, disposed: true });
});

it("disposes a retained named source without target access or another create", async () => {
  const f = fixture();
  f.retain();
  await f.dispose();
  expect(f.state.disposed).toBe(true);
  expect(f.stats.creates).toBe(0);
  expect(f.stats.reads).toBe(0);
  expect(f.stats.writes).toBe(0);
  expect(f.stats.gets).toBe(1);
  expect(f.stats.deletes).toBe(1);
});

it("disposal alone preserves unresolved create and never creates or installs", async () => {
  const f = fixture();
  f.setState({ sourceCreationAttempted: true, disposed: false });
  await expect(f.dispose()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.stats.creates).toBe(0);
  expect(f.stats.writes).toBe(0);
  expect(f.state.disposed).toBe(false);
});

it("records an unknown-create source found by name before uncertain deletion, then settles known404", async () => {
  const f = fixture();
  f.faults.createUnknown = true;
  f.faults.getUnknown = true;
  await expect(f.install()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.state.sourceSandboxId).toBeUndefined();
  f.faults.getUnknown = false;
  f.faults.deleteUnknown = true;
  await expect(f.dispose()).rejects.toMatchObject({ code: "reconciliation_required" });
  expect(f.state.sourceSandboxId).toBe(f.name);
  expect(f.state.disposed).toBe(false);
  await f.dispose();
  expect(f.state.disposed).toBe(true);
  expect(f.stats.creates).toBe(1);
  expect(f.stats.writes).toBe(0);
  expect(f.stats.deletes).toBe(1);
});

it("settles an actual SDK404 from deleting the exact owned source", async () => {
  const f = fixture();
  f.faults.deleteNotFound = true;
  await f.install();
  expect(f.state.disposed).toBe(true);
  expect(f.state.installed).toBe(true);
  expect(f.stats.creates).toBe(1);
  expect(f.stats.deletes).toBe(1);
});
