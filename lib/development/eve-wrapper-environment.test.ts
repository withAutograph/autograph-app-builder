import { privateComputeLimitsSchema } from "../sandbox/private-compute-profile";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { developmentLaunchEnvironment } from "./dev-package";
import { prepareDevelopmentEveWrapperEnvironment } from "./eve-wrapper-environment";
import { createLocalEveInvocation } from "../eve/local-eve-launch";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});
const fixture = async (providerTeam = "team_example") => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "builder-startup-chain-")));
  roots.push(root);
  await chmod(root, 0o700);
  const repositoryRoot = path.join(root, "repository");
  const runsRoot = path.join(root, "runs");
  const supervisorRoot = path.join(runsRoot, "supervisor-owned");
  const cycle = path.join(supervisorRoot, "cycle-owned");
  const applicationRoot = path.join(cycle, "eve-application/source");
  const runtimeHome = path.join(cycle, "home");
  const workflowData = path.join(cycle, "workflow-data");
  const sourceRoot = path.join(root, "arrusted");
  const destinationRoot = path.join(root, "destination");
  await Promise.all(
    [
      repositoryRoot,
      runsRoot,
      supervisorRoot,
      cycle,
      path.dirname(applicationRoot),
      applicationRoot,
      runtimeHome,
      workflowData,
      sourceRoot,
      destinationRoot,
      path.join(repositoryRoot, ".vercel"),
    ].map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }),
  );
  await writeFile(
    path.join(repositoryRoot, ".vercel/project.json"),
    JSON.stringify({
      projectId: "prj_example",
      orgId: "team_example",
      projectName: "builder-local",
    }),
    { mode: 0o600 },
  );
  const cycleFile = path.join(root, "eve-cycle");
  await writeFile(cycleFile, "c".repeat(64), { mode: 0o600 });
  const argumentsFile = path.join(root, "cli-arguments");
  const vercelExecutable = path.join(root, "vercel");
  await writeFile(
    vercelExecutable,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argumentsFile}'\nprintf '%s' '${JSON.stringify({ id: providerTeam, billing: { plan: "pro" }, limited: false })}'\n`,
    { mode: 0o700 },
  );
  const closed = developmentLaunchEnvironment({
    sourceRoot,
    snapshotRoot: sourceRoot,
    destinationRoot,
    sourceSha: "a".repeat(40),
    sourceTree: "b".repeat(40),
    fingerprint: "c".repeat(64),
    dependencyKey: "d".repeat(64),
    evePort: 23_117,
  });
  const input = {
    cycleFile,
    closed,
    applicationRoot,
    runsRoot,
    supervisorRoot,
    runtimeHome,
    workflowData,
    repositoryRoot,
    nodeExecutable: process.execPath,
    vercelExecutable,
    environment: {
      NODE_ENV: "development" as const,
      HOME: root,
      PATH: "/usr/bin:/bin",
      VERCEL_TOKEN: "never-forward",
      AI_GATEWAY_API_KEY: "never-forward",
      APP_BUILDER_PRIVATE_COMPUTE_LIMITS: "forged ambient capacity",
      APP_BUILDER_LOCAL_EVE_CYCLE_FILE: "/foreign-cycle",
    },
    signal: new AbortController().signal,
  };
  return { argumentsFile, input, vercelExecutable };
};

it("carries the actual supervisor cycle/source and read-only observation through the real Eve invocation", async () => {
  const f = await fixture();
  const wrapper = await prepareDevelopmentEveWrapperEnvironment(f.input);
  const observedArguments = await readFile(f.argumentsFile, "utf-8");
  expect(observedArguments.trim().split("\n")).toEqual([
    "api",
    "/v2/teams/team_example",
    "--scope",
    "team_example",
  ]);
  expect(wrapper.APP_BUILDER_LOCAL_EVE_CYCLE_FILE).toBe(f.input.cycleFile);
  const limits = privateComputeLimitsSchema.parse(
    JSON.parse(wrapper.APP_BUILDER_PRIVATE_COMPUTE_LIMITS ?? "null"),
  );
  const invocation = createLocalEveInvocation({
    environment: wrapper,
    repositoryRoot: f.input.repositoryRoot,
    pinnedNode: process.execPath,
    eveCli: path.join(f.input.repositoryRoot, "eve.js"),
    oidcToken: "test-project-oidc",
    privateComputeLimits: limits,
    vercelProject: { projectId: "prj_example", orgId: "team_example" },
  });
  expect(invocation.environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE).toBe(f.input.cycleFile);
  expect(invocation.environment.APP_BUILDER_PRIVATE_COMPUTE_LIMITS).toBe(JSON.stringify(limits));
  expect(invocation.environment.APP_BUILDER_DEVELOPMENT_SOURCE_SHA).toBe("a".repeat(40));
  expect(invocation.environment.APP_BUILDER_DEVELOPMENT_SOURCE_TREE).toBe("b".repeat(40));
  expect(invocation.environment.WORKFLOW_LOCAL_BASE_URL).toBe("http://127.0.0.1:23117");
  expect(invocation.environment.VERCEL_TOKEN).toBeUndefined();
  expect(invocation.environment.AI_GATEWAY_API_KEY).toBeUndefined();
});

it("leaves default compute available after an unavailable read without forwarding ambient claims", async () => {
  const f = await fixture();
  await writeFile(f.vercelExecutable, "#!/bin/sh\nexit 1\n");
  const wrapper = await prepareDevelopmentEveWrapperEnvironment(f.input);
  expect(wrapper.APP_BUILDER_PRIVATE_COMPUTE_LIMITS).toBeUndefined();
  expect(wrapper.APP_BUILDER_LOCAL_EVE_CYCLE_FILE).toBe(f.input.cycleFile);
  expect(wrapper.VERCEL_TOKEN).toBeUndefined();
  expect(wrapper.AI_GATEWAY_API_KEY).toBeUndefined();
});

it("does not forward another provider team's observation", async () => {
  const f = await fixture("team_foreign");
  const wrapper = await prepareDevelopmentEveWrapperEnvironment(f.input);
  expect(wrapper.APP_BUILDER_PRIVATE_COMPUTE_LIMITS).toBeUndefined();
});
