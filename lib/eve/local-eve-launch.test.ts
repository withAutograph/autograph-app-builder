import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChildProcess } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  createLocalEveInvocation,
  localEveLaunchReceipt,
  waitForForwardedEveChild,
} from "./local-eve-launch";

function fixture() {
  const stateRoot = realpathSync(
    mkdtempSync(join(tmpdir(), "app-builder-local-eve-")),
  );
  chmodSync(stateRoot, 0o700);
  const repositoryRoot = join(stateRoot, "repository");
  const runsRoot = join(stateRoot, "runs");
  mkdirSync(repositoryRoot, { mode: 0o700 });
  mkdirSync(runsRoot, { mode: 0o700 });
  const activeRun = realpathSync(mkdtempSync(join(runsRoot, "run-")));
  const supervisorRoot = realpathSync(mkdtempSync(join(runsRoot, "supervisor-")));
  const cycleRoot = realpathSync(mkdtempSync(join(supervisorRoot, "cycle-")));
  const applicationRoot = join(cycleRoot, "eve-application/source");
  const sourceRoot = join(activeRun, "source");
  const runtimeHome = join(cycleRoot, "home");
  const workflowData = join(cycleRoot, "workflow-data");
  const destinationRoot = join(stateRoot, "destination");
  for (const path of [
    join(cycleRoot, "eve-application"),
    applicationRoot,
    runtimeHome,
    workflowData,
    destinationRoot,
  ])
    mkdirSync(path, { recursive: true, mode: 0o700 });
  mkdirSync(sourceRoot, { mode: 0o500 });
  const environment: Record<string, string> = {
    APP_BUILDER_DEV_RUNS_ROOT: realpathSync(runsRoot),
    APP_BUILDER_DEV_SUPERVISOR_ROOT: supervisorRoot,
    APP_BUILDER_DEV_RUNTIME_HOME: realpathSync(runtimeHome),
    APP_BUILDER_DEV_EVE_ROOT: realpathSync(applicationRoot),
    APP_BUILDER_EVE_PORT: "2000",
    WORKFLOW_LOCAL_BASE_URL: "http://127.0.0.1:2000",
    WORKFLOW_LOCAL_DATA_DIR: realpathSync(workflowData),
    WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_EXECUTION_BUNDLE: "local-development",
    APP_BUILDER_SANDBOX_PROVIDER: "vercel",
    APP_BUILDER_DEVELOPMENT_SOURCE_SHA: "a".repeat(40),
    APP_BUILDER_DEVELOPMENT_SOURCE_TREE: "b".repeat(40),
    APP_BUILDER_DEVELOPMENT_SOURCE_FINGERPRINT: "c".repeat(64),
    APP_BUILDER_DEVELOPMENT_DEPENDENCY_KEY: "d".repeat(64),
    APP_BUILDER_LOCAL_ADAPTER: "1",
    APP_BUILDER_LOCAL_PUBLICATION: "0",
    APP_BUILDER_BRANCH_WORKTREE_PUBLICATION: "0",
    APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
    APP_BUILDER_FRESH_BOOTSTRAP_ENABLED: "0",
    APP_BUILDER_LOCAL_PROVIDER_EMULATION: "0",
    APP_BUILDER_LOCAL_AUTH_EMULATION: "0",
    EVE_HOSTED_ADAPTER: "0",
    EVE_AGENT_HOST: "http://127.0.0.1:2000",
    REPOSITORY_LOCAL_ROOTS: realpathSync(sourceRoot),
    REPOSITORY_WORKSPACE_ROOT: realpathSync(destinationRoot),
  };
  return { applicationRoot, environment, repositoryRoot };
}

describe("closed local Eve launch", () => {
  it("forwards supervisor termination and waits for Eve to exit", async () => {
    const signals = new EventEmitter();
    const child = new EventEmitter() as ChildProcess;
    const forwarded: NodeJS.Signals[] = [];
    Object.defineProperties(child, {
      exitCode: { value: null, writable: true },
      signalCode: { value: null, writable: true },
    });
    child.kill = ((signal?: NodeJS.Signals | number) => {
      if (typeof signal === "string") forwarded.push(signal);
      return true;
    }) as ChildProcess["kill"];

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

  it("projects project OIDC only into the fresh Eve application", () => {
    const input = fixture();
    const sentinel = "oidc-sentinel-must-not-leak";
    const invocation = createLocalEveInvocation({
      repositoryRoot: input.repositoryRoot,
      pinnedNode: "/mise/node/24.18.0/bin/node",
      eveCli: "/repository/node_modules/.pnpm/eve/bin/eve.js",
      oidcToken: sentinel,
      vercelProject: { orgId: "team_example", projectId: "prj_example" },
      environment: input.environment,
    });

    expect(invocation.cwd).toBe(realpathSync(input.applicationRoot));
    expect(invocation.environment.VERCEL_OIDC_TOKEN).toBe(sentinel);
    expect(invocation.environment.APP_BUILDER_SANDBOX_PROVIDER).toBe("vercel");
    expect(invocation.environment.APP_BUILDER_EXECUTION_BUNDLE).toBe(
      "local-development",
    );
    expect(invocation.environment.WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS).toBe("0");
    expect(invocation.environment.WORKFLOW_LOCAL_BASE_URL).toBe(
      "http://127.0.0.1:2000",
    );
    expect(invocation.environment.APP_BUILDER_SANDBOX_IMAGE).toBeUndefined();
    expect(invocation.environment.MSB_HOME).toBeUndefined();
    const receipt = JSON.stringify(localEveLaunchReceipt(invocation));
    expect(receipt).not.toContain(sentinel);
    expect(receipt).not.toContain("team_example");
    expect(receipt).not.toContain("prj_example");
  });

  it("rejects a workflow queue endpoint that differs from the Eve adapter", () => {
    const input = fixture();
    input.environment.WORKFLOW_LOCAL_BASE_URL = "http://127.0.0.1:2001";

    expect(() =>
      createLocalEveInvocation({
        repositoryRoot: input.repositoryRoot,
        pinnedNode: "/mise/node/24.18.0/bin/node",
        eveCli: "/repository/node_modules/.pnpm/eve/bin/eve.js",
        oidcToken: "local-oidc-token",
        vercelProject: { orgId: "team_example", projectId: "prj_example" },
        environment: input.environment,
      }),
    ).toThrow("Local Eve workflow queue binding was invalid.");
  });

  it.each([
    ["static Vercel token", { VERCEL_TOKEN: "nope" }],
    ["static AI Gateway key", { AI_GATEWAY_API_KEY: "nope" }],
    ["Microsandbox image", { APP_BUILDER_SANDBOX_IMAGE: "latest" }],
    ["Microsandbox home", { MSB_HOME: "/tmp/msb" }],
    ["wrong backend", { APP_BUILDER_SANDBOX_PROVIDER: "microsandbox" }],
    ["state recovery", { WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "1" }],
  ])("rejects %s before starting Eve", (_name, override) => {
    const input = fixture();
    expect(() =>
      createLocalEveInvocation({
        repositoryRoot: input.repositoryRoot,
        pinnedNode: "/mise/node/24.18.0/bin/node",
        eveCli: "/repository/node_modules/.pnpm/eve/bin/eve.js",
        oidcToken: "sentinel",
        vercelProject: { orgId: "team_example", projectId: "prj_example" },
        environment: { ...input.environment, ...override },
      }),
    ).toThrow();
  });
});
