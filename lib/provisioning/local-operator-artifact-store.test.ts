/* oxlint-disable sonarjs/no-internal-api-use, eslint/no-bitwise -- Owned filesystem fixtures exercise actual Eve approval context serialization and permission masks. Runtime internals are never product imports. */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, stat, readdir, chmod } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import {
  ContextContainer,
  contextStorage,
} from "../../node_modules/eve/dist/src/context/container.js";
import {
  serializeContext,
  deserializeContext,
} from "../../node_modules/eve/dist/src/context/serialize.js";
import {
  assertApprovedPrivateApplySession,
  requestPrivateApplyApproval,
  recordApprovedPrivateApply,
} from "../agent/private-apply-authority";
import {
  createLocalOperatorArtifactStorage,
  readLocalOperatorArtifactAuthority,
} from "./local-operator-artifact-store";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { force: true, recursive: true });
    }),
  );
});
const fixture = async () => {
  const stateRoot = await realpath(await mkdtemp(path.join(tmpdir(), "local-operator-artifact-")));
  roots.push(stateRoot);
  const runsRoot = path.join(stateRoot, "runs");
  await mkdir(runsRoot, { mode: 0o700 });
  const environment = {
    APP_BUILDER_DEV_RUNS_ROOT: runsRoot,
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    EVE_HOSTED_ADAPTER: "0",
  };
  const authority = await readLocalOperatorArtifactAuthority(environment);
  if (authority === undefined) {
    throw new Error("owned local authority missing");
  }
  const context: OperatorArtifactContext = {
    authority,
    target: { appId: "fixture-app", sessionId: "owned-session" },
  };
  const approval = {
    appId: "fixture-app",
    appSpecDigest: "a".repeat(64),
    proposalDigest: "proposal",
    sessionId: "owned-session",
    workspaceId: "private-workspace",
  };
  const container = new ContextContainer();
  contextStorage.run(container, () => {
    requestPrivateApplyApproval(approval, "approve");
    recordApprovedPrivateApply(approval, "approve");
  });
  const assertCurrentOwner = async (current: OperatorArtifactContext) => {
    assertApprovedPrivateApplySession({
      ...approval,
      appId: current.target.appId,
      sessionId: current.target.sessionId,
    });
    const actual = await readLocalOperatorArtifactAuthority(environment);
    if (JSON.stringify(actual) !== JSON.stringify(current.authority)) {
      throw new Error("local owner changed");
    }
  };
  return { approval, assertCurrentOwner, authority, container, context, environment, stateRoot };
};
const selection = (letter: string): CompiledOperatorReleaseSelection => ({
  appId: "fixture-app",
  appSpecDigest: "a".repeat(64),
  artifactRef: `_protected-operator/artifacts/generated-release/fixture-app/${letter.repeat(64)}`,
  manifestSha256: letter.repeat(64),
  releaseId: `release-${letter}`,
  schemaSha256: letter.repeat(64),
  version: 1,
});
describe("owner-bound local private operator artifacts", () => {
  it("reads exact retained history across accepted specs without substituting latest", async () => {
    const f = await fixture();
    await contextStorage.run(f.container, async () => {
      const storage = await createLocalOperatorArtifactStorage(f);
      const oldest = selection("a");
      const predecessor = selection("b");
      const latest = { ...selection("c"), appSpecDigest: "c".repeat(64) };
      await storage.selections.record(f.context, "oldest", oldest);
      await storage.selections.record(f.context, "predecessor", predecessor);
      await storage.selections.record(f.context, "latest", latest);
      if (storage.selections.readExact === undefined) {
        throw new Error("Exact reader unavailable");
      }
      expect(
        await storage.selections.readExact(f.context, { artifactRef: predecessor.artifactRef }),
      ).toEqual(predecessor);
      expect(
        await storage.selections.readExact(f.context, {
          releaseId: predecessor.releaseId,
          schemaSha256: predecessor.schemaSha256,
        }),
      ).toEqual(predecessor);
      expect(
        await storage.selections.readExact(f.context, {
          releaseId: latest.releaseId,
          schemaSha256: predecessor.schemaSha256,
        }),
      ).toBeUndefined();
      await expect(
        storage.selections.readExact(
          { ...f.context, target: { ...f.context.target, sessionId: "foreign-session" } },
          { artifactRef: predecessor.artifactRef },
        ),
      ).rejects.toThrow();
      const changed = { ...f.approval, appId: "other-app" };
      requestPrivateApplyApproval(changed, "revoke-old-scope");
      recordApprovedPrivateApply(changed, "revoke-old-scope");
      await expect(
        storage.selections.readExact(f.context, { artifactRef: predecessor.artifactRef }),
      ).rejects.toThrow();
    });
  });
  it("stores immutable private chunks without hosted authority and survives a serialized Eve boundary", async () => {
    const f = await fixture();
    await contextStorage.run(f.container, async () => {
      const storage = await createLocalOperatorArtifactStorage(f);
      const chunk = {
        artifactRef: selection("a").artifactRef,
        chunkIndex: 1,
        content: "actual privately captured bytes",
      };
      await storage.store.put(f.context, chunk);
      await storage.store.put(f.context, chunk);
      expect(await storage.store.read(f.context, chunk.artifactRef, 1)).toBe(chunk.content);
      await expect(
        storage.store.put(f.context, { ...chunk, content: "conflict" }),
      ).rejects.toThrow();
      await expect(
        storage.store.read(
          { ...f.context, target: { ...f.context.target, sessionId: "other-session" } },
          chunk.artifactRef,
          1,
        ),
      ).rejects.toThrow();
      await expect(
        storage.store.read(
          { ...f.context, target: { ...f.context.target, appId: "other-app" } },
          chunk.artifactRef,
          1,
        ),
      ).rejects.toThrow();
    });
    const resumed = await deserializeContext(serializeContext(f.container));
    await contextStorage.run(resumed, async () => {
      const storage = await createLocalOperatorArtifactStorage(f);
      expect(await storage.store.read(f.context, selection("a").artifactRef, 1)).toBe(
        "actual privately captured bytes",
      );
    });
    const storageRoot = path.join(f.stateRoot, "operator-artifacts");
    const storageInfo = await stat(storageRoot);
    expect(storageInfo.mode & 0o077).toBe(0);
    const [owned] = await readdir(storageRoot);
    if (owned === undefined) {
      throw new Error("owned storage missing");
    }
    const ownedDirectory = path.join(storageRoot, owned);
    const names = await readdir(ownedDirectory);
    const files = await Promise.all(
      names.map(async (name) => await stat(path.join(ownedDirectory, name))),
    );
    for (const info of files) {
      expect(info.mode & 0o077).toBe(0);
    }
  });
  it("finalizes selections atomically, handles concurrent publication and never promotes old retry", async () => {
    const f = await fixture();
    await contextStorage.run(f.container, async () => {
      const storage = await createLocalOperatorArtifactStorage(f);
      const a = selection("a");
      const b = selection("b");
      const c = selection("c");
      await storage.selections.record(f.context, "first", a);
      await storage.selections.record(f.context, "second", b);
      await storage.selections.record(f.context, "first", a);
      expect(await storage.selections.read(f.context, a.appSpecDigest)).toEqual(b);
      await expect(storage.selections.record(f.context, "first", c)).rejects.toThrow();
      await Promise.all([
        storage.selections.record(f.context, "third", c),
        storage.selections.record(f.context, "fourth", a),
      ]);
      expect([a, c]).toContainEqual(await storage.selections.read(f.context, a.appSpecDigest));
      await storage.selections.record(f.context, "fifth", b);
      expect(await storage.selections.read(f.context, a.appSpecDigest)).toEqual(b);
      await Promise.all([
        storage.selections.record(f.context, "duplicate", c),
        storage.selections.record(f.context, "duplicate", c),
      ]);
      expect(await storage.selections.read(f.context, a.appSpecDigest)).toEqual(c);
      const changed = { ...f.approval, appId: "other-app" };
      requestPrivateApplyApproval(changed, "revoke-old-scope");
      recordApprovedPrivateApply(changed, "revoke-old-scope");
      await expect(storage.selections.read(f.context, a.appSpecDigest)).rejects.toThrow();
      await expect(
        storage.selections.read(
          { ...f.context, target: { ...f.context.target, sessionId: "other" } },
          a.appSpecDigest,
        ),
      ).rejects.toThrow();
    });
  });
  it("rejects unsafe profile and owner permissions instead of using hosted fallback", async () => {
    const f = await fixture();
    expect(
      await readLocalOperatorArtifactAuthority({ APP_BUILDER_EXECUTION_MODE: "production" }),
    ).toBeUndefined();
    await expect(
      readLocalOperatorArtifactAuthority({ ...f.environment, EVE_HOSTED_ADAPTER: "1" }),
    ).rejects.toThrow();
    await chmod(f.stateRoot, 0o755);
    await expect(readLocalOperatorArtifactAuthority(f.environment)).rejects.toThrow();
  });
});
