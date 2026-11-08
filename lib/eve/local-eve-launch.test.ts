import { EventEmitter } from "node:events";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  readLocalOperatorArtifactAuthority,
  createLocalOperatorArtifactStorage,
} from "../provisioning/local-operator-artifact-store";

import {
  createLocalEveInvocation,
  localEveLaunchReceipt,
  waitForForwardedEveChild,
} from "./local-eve-launch";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function fixture() {
  const stateRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "app-builder-local-eve-")));
  chmodSync(stateRoot, 0o700);
  const repositoryRoot = path.join(stateRoot, "repository");
  const runsRoot = path.join(stateRoot, "runs");
  mkdirSync(repositoryRoot, { mode: 0o700 });
  mkdirSync(runsRoot, { mode: 0o700 });
  const supervisorRoot = realpathSync(mkdtempSync(path.join(runsRoot, "supervisor-")));
  const cycleRoot = realpathSync(mkdtempSync(path.join(supervisorRoot, "cycle-")));
  const applicationRoot = path.join(cycleRoot, "eve-application/source");
  const sourceRoot = path.join(stateRoot, "actual-arrusted");
  const runtimeHome = path.join(cycleRoot, "home");
  const workflowData = path.join(cycleRoot, "workflow-data");
  const destinationRoot = path.join(stateRoot, "destination");
  for (const directoryPath of [
    path.join(cycleRoot, "eve-application"),
    applicationRoot,
    sourceRoot,
    runtimeHome,
    workflowData,
    destinationRoot,
  ]) {
    mkdirSync(directoryPath, { mode: 0o700, recursive: true });
  }
  const cycleFile = path.join(stateRoot, "eve-cycle");
  writeFileSync(cycleFile, "c".repeat(64), { mode: 0o600 });
  // oxlint-disable-next-line anti-slop/no-known-value-widening -- Keep the dictionary open for the supported keys.
  const environment: Record<string, string> = {
    APP_BUILDER_LOCAL_EVE_CYCLE_FILE: cycleFile,
    APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "0",
    APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY: "d".repeat(64),
    APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: "c".repeat(64),
    APP_BUILDER_DEVELOPMENT_SOURCE_SHA: "a".repeat(40),
    APP_BUILDER_DEVELOPMENT_SOURCE_TREE: "b".repeat(40),
    APP_BUILDER_DEV_EVE_ROOT: realpathSync(applicationRoot),
    APP_BUILDER_DEVELOPMENT_SOURCE_ROOT: realpathSync(sourceRoot),
    APP_BUILDER_DEV_RUNS_ROOT: realpathSync(runsRoot),
    APP_BUILDER_DEV_RUNTIME_HOME: realpathSync(runtimeHome),
    APP_BUILDER_DEV_SUPERVISOR_ROOT: supervisorRoot,
    APP_BUILDER_EVE_PORT: "2000",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "0",
    APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_LOCAL_AUTH_EMULATION: "0",
    APP_BUILDER_LOCAL_PROVIDER_EMULATION: "0",
    APP_BUILDER_LOCAL_PUBLICATION: "0",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    EVE_AGENT_HOST: "http://127.0.0.1:2000",
    EVE_HOSTED_ADAPTER: "0",
    REPOSITORY_LOCAL_ROOTS: realpathSync(sourceRoot),
    REPOSITORY_WORKSPACE_ROOT: realpathSync(destinationRoot),
    WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:2000",
    WORKFLOW_LOCAL_DATA_DIR: realpathSync(workflowData),
    WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
  };
  return { applicationRoot, environment, repositoryRoot };
}

describe("closed local Eve launch", () => {
  it("forwards supervisor termination and waits for Eve to exit", async () => {
    // Node's signal-target contract requires EventEmitter's once/off API.
    // oxlint-disable-next-line unicorn/prefer-event-target
    const signals = new EventEmitter();
    const forwarded: NodeJS.Signals[] = [];
    // ChildProcess is an EventEmitter in Node, not an EventTarget.
    // oxlint-disable-next-line unicorn/prefer-event-target
    const child = Object.assign(new EventEmitter(), {
      kill: (signal?: NodeJS.Signals | number) => {
        if (typeof signal === "string") {
          forwarded.push(signal);
        }
        return true;
      },
    });
    Object.defineProperties(child, {
      exitCode: { value: null, writable: true },
      signalCode: { value: null, writable: true },
    });

    const stopped = waitForForwardedEveChild(child, signals);
    signals.emit("SIGTERM");
    expect(forwarded).toEqual(["SIGTERM"]);

    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    child.emit("exit", 0, null);
    await expect(stopped).resolves.toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
  });

  it("forwards only the typed supervisor observation matching the linked project", () => {
    const input = fixture();
    input.environment.APP_BUILDER_PRIVATE_COMPUTE_LIMITS = "untrusted ambient value";
    const options = {
      environment: input.environment,
      eveCli: "/repository/node_modules/.pnpm/eve/bin/eve.js",
      oidcToken: "test-oidc",
      pinnedNode: "/mise/node/24.18.0/bin/node",
      repositoryRoot: input.repositoryRoot,
      vercelProject: { orgId: "team_example", projectId: "prj_example" },
    };
    expect(
      createLocalEveInvocation(options).environment.APP_BUILDER_PRIVATE_COMPUTE_LIMITS,
    ).toBeUndefined();
    const privateComputeLimits = {
      version: 1 as const,
      teamId: "team_example",
      projectId: "prj_example",
      plan: "pro" as const,
      maxVcpus: 8 as const,
      limited: false as const,
      observedAt: "2026-11-03T12:00:00.000Z",
    };
    const invocation = createLocalEveInvocation({ ...options, privateComputeLimits });
    expect(invocation.environment.APP_BUILDER_PRIVATE_COMPUTE_LIMITS).toBe(
      JSON.stringify(privateComputeLimits),
    );
    expect(() =>
      createLocalEveInvocation({
        ...options,
        privateComputeLimits: { ...privateComputeLimits, projectId: "prj_other" },
      }),
    ).toThrow("linked");
  });

  it("projects project OIDC only into the fresh Eve application", () => {
    const input = fixture();
    const sentinel = "oidc-sentinel-must-not-leak";
    const invocation = createLocalEveInvocation({
      environment: input.environment,
      eveCli: "/repository/node_modules/.pnpm/eve/bin/eve.js",
      oidcToken: sentinel,
      pinnedNode: "/mise/node/24.18.0/bin/node",
      repositoryRoot: input.repositoryRoot,
      vercelProject: { orgId: "team_example", projectId: "prj_example" },
    });

    expect(invocation.cwd).toBe(realpathSync(input.applicationRoot));
    expect(invocation.args).toContain("--no-default-extensions");
    expect(invocation.args).not.toContain("--resume");
    const recovering = createLocalEveInvocation({
      environment: input.environment,
      eveCli: "/repository/node_modules/.pnpm/eve/bin/eve.js",
      oidcToken: sentinel,
      pinnedNode: "/mise/node/24.18.0/bin/node",
      repositoryRoot: input.repositoryRoot,
      resume: true,
      vercelProject: { orgId: "team_example", projectId: "prj_example" },
    });
    expect(recovering.args).toContain("--resume");
    expect(recovering.environment.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS).toBe("0");
    expect(invocation.environment.VERCEL_OIDC_TOKEN).toBe(sentinel);
    expect(invocation.environment.APP_BUILDER_SANDBOX_PROVIDER).toBe("vercel");
    expect(invocation.environment.APP_BUILDER_EXECUTION_BUNDLE).toBe("local-development");
    expect(invocation.environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE).toBe(
      input.environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE,
    );
    expect(invocation.environment.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS).toBe("0");
    expect(invocation.environment.REPOSITORY_LOCAL_ROOTS).toBe(
      realpathSync(path.join(path.dirname(input.repositoryRoot), "actual-arrusted")),
    );
    expect(invocation.environment.WORKFLOW_LOCAL_BASE_URL).toBe("http://127.0.0.1:2000");
    expect(invocation.environment.APP_BUILDER_SANDBOX_IMAGE).toBeUndefined();
    expect(invocation.environment.MSB_HOME).toBeUndefined();
    const receipt = JSON.stringify(localEveLaunchReceipt(invocation));
    expect(receipt).not.toContain(sentinel);
    expect(receipt).not.toContain("team_example");
    expect(receipt).not.toContain("prj_example");
  });

  it("keeps Eve bound to the canonical Arrusted checkout as its bytes change", () => {
    const input = fixture();
    const liveSourceFile = path.join(
      input.environment.APP_BUILDER_DEVELOPMENT_SOURCE_ROOT,
      "brief.md",
    );
    writeFileSync(liveSourceFile, "first planning input\n");
    const invocation = createLocalEveInvocation({
      environment: input.environment,
      eveCli: "/repository/node_modules/.pnpm/eve/bin/eve.js",
      oidcToken: "local-oidc-token",
      pinnedNode: "/mise/node/24.18.0/bin/node",
      repositoryRoot: input.repositoryRoot,
      vercelProject: { orgId: "team_example", projectId: "prj_example" },
    });

    writeFileSync(liveSourceFile, "edited planning input\n");
    const liveRoot = invocation.environment.REPOSITORY_LOCAL_ROOTS;
    if (liveRoot === undefined) {
      throw new Error("Live source root was not configured.");
    }
    expect(liveRoot).toBe(input.environment.APP_BUILDER_DEVELOPMENT_SOURCE_ROOT);
    expect(readFileSync(path.join(liveRoot, "brief.md"), "utf-8")).toBe("edited planning input\n");
  });

  it("rejects a workflow queue endpoint that differs from the Eve adapter", () => {
    const input = fixture();
    input.environment.WORKFLOW_LOCAL_BASE_URL = "http://127.0.0.1:2001";

    expect(() =>
      createLocalEveInvocation({
        environment: input.environment,
        eveCli: "/repository/node_modules/.pnpm/eve/bin/eve.js",
        oidcToken: "local-oidc-token",
        pinnedNode: "/mise/node/24.18.0/bin/node",
        repositoryRoot: input.repositoryRoot,
        vercelProject: { orgId: "team_example", projectId: "prj_example" },
      }),
    ).toThrow("Local Eve workflow queue binding was invalid.");
  });

  it("rejects a live source binding that differs from the repository source root", () => {
    const input = fixture();
    input.environment.REPOSITORY_LOCAL_ROOTS = input.environment.APP_BUILDER_DEV_EVE_ROOT;

    expect(() =>
      createLocalEveInvocation({
        environment: input.environment,
        eveCli: "/repository/node_modules/.pnpm/eve/bin/eve.js",
        oidcToken: "local-oidc-token",
        pinnedNode: "/mise/node/24.18.0/bin/node",
        repositoryRoot: input.repositoryRoot,
        vercelProject: { orgId: "team_example", projectId: "prj_example" },
      }),
    ).toThrow("Development Arrusted source binding was inconsistent.");
  });

  it.each([
    ["static Vercel token", { VERCEL_TOKEN: "nope" }],
    ["static AI Gateway key", { AI_GATEWAY_API_KEY: "nope" }],
    ["Microsandbox image", { APP_BUILDER_SANDBOX_IMAGE: "latest" }],
    // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture value exercises sandbox environment filtering.
    ["Microsandbox home", { MSB_HOME: "/tmp/msb" }],
    ["wrong backend", { APP_BUILDER_SANDBOX_PROVIDER: "microsandbox" }],
    ["state recovery", { WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "1" }],
  ])("rejects %s before starting Eve", (_name, override) => {
    const input = fixture();
    expect(() =>
      createLocalEveInvocation({
        environment: { ...input.environment, ...override },
        eveCli: "/repository/node_modules/.pnpm/eve/bin/eve.js",
        oidcToken: "sentinel",
        pinnedNode: "/mise/node/24.18.0/bin/node",
        repositoryRoot: input.repositoryRoot,
        vercelProject: { orgId: "team_example", projectId: "prj_example" },
      }),
    ).toThrow();
  });
});

it("the real child launch can retain private planning artifacts without a hosted operator", async () => {
  const f = fixture();
  const invocation = createLocalEveInvocation({
    repositoryRoot: f.repositoryRoot,
    environment: f.environment,
    pinnedNode: process.execPath,
    eveCli: "/owned/eve-cli.mjs",
    oidcToken: "synthetic-project-oidc",
    vercelProject: { projectId: "project", orgId: "team" },
  });
  const authority = await readLocalOperatorArtifactAuthority(invocation.environment);
  expect(authority).toBeDefined();
  if (authority === undefined) {
    throw new Error("missing local planning authority");
  }
  const context = {
    authority,
    target: { appId: "supplier-spend", sessionId: "saved-local-session" },
  };
  const artifacts = await createLocalOperatorArtifactStorage({
    authority,
    assertCurrentOwner: (current) => {
      expect(current).toEqual(context);
      return Promise.resolve();
    },
  });
  const artifactRef = `_protected-operator/artifacts/source-review-context/supplier-spend/${"a".repeat(64)}`;
  await artifacts.store.put(context, {
    artifactRef,
    chunkIndex: 0,
    content: "private reviewed app plan",
  });
  expect(await artifacts.store.read(context, artifactRef, 0)).toBe("private reviewed app plan");
});

it("the real child launch can retain private planning artifacts without a hosted operator", async () => {
  const f = fixture();
  const invocation = createLocalEveInvocation({
    repositoryRoot: f.repositoryRoot,
    environment: f.environment,
    pinnedNode: process.execPath,
    eveCli: "/owned/eve-cli.mjs",
    oidcToken: "synthetic-project-oidc",
    vercelProject: { projectId: "project", orgId: "team" },
  });
  const authority = await readLocalOperatorArtifactAuthority(invocation.environment);
  expect(authority).toBeDefined();
  if (authority === undefined) {
    throw new Error("missing local planning authority");
  }
  const context = {
    authority,
    target: { appId: "supplier-spend", sessionId: "saved-local-session" },
  };
  const artifacts = await createLocalOperatorArtifactStorage({
    authority,
    assertCurrentOwner: (current) => {
      expect(current).toEqual(context);
      return Promise.resolve();
    },
  });
  const artifactRef = `_protected-operator/artifacts/source-review-context/supplier-spend/${"a".repeat(64)}`;
  await artifacts.store.put(context, {
    artifactRef,
    chunkIndex: 0,
    content: "private reviewed app plan",
  });
  expect(await artifacts.store.read(context, artifactRef, 0)).toBe("private reviewed app plan");
});
