import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  custodyActorDigest,
  custodyGrantDigest,
  custodyPlanDigest,
  custodyPlanSchema,
  custodyRecordSchema,
} from "./vercel-token-key-custody";
import { custodyEnrollmentDigest } from "./vercel-token-key-custody-enrollment";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const operationRef = "11111111-1111-4111-8111-111111111111";
const plan = custodyPlanSchema.parse({
  action: "transfer-active-vercel-token-key-to-operator-preview",
  actorAuthorityDigest: custodyActorDigest(authority),
  approvalExpiresAt: "2099-10-10T13:00:00Z",
  destination: {
    environment: "preview",
    gitBranch: null,
    key: "VERCEL_INTEGRATION_TOKEN_KEY",
    projectId: "operator",
    requiredVersion: "v1",
    teamId: "team",
    type: "sensitive",
    versionKey: "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
    write: "create-only",
  },
  installationId: "installation",
  operationRef,
  ownerSessionId: "session",
  source: {
    deploymentId: "source-deployment",
    environment: "production",
    key: "VERCEL_INTEGRATION_TOKEN_KEY",
    keyVersion: "v1",
    projectId: "builder",
    teamId: "team",
    versionKey: "VERCEL_INTEGRATION_TOKEN_KEY_VERSION",
  },
  version: 1,
});
const setupGrant = {
  approvalRef: "approval",
  approvedAt: "2026-10-10T11:00:00Z",
  approvedPlanDigest: custodyPlanDigest(plan),
  expiresAt: plan.approvalExpiresAt,
  grantRef: "grant",
  operationRef,
  originalActor: authority,
  ownerSessionId: "session",
  scope: "source-global-active-v1-key-custody" as const,
  version: 1 as const,
};
const record = custodyRecordSchema.parse({
  approvalRef: "approval",
  fenceGeneration: 0,
  grantDigest: custodyGrantDigest(setupGrant),
  grantRef: "grant",
  kind: "vercel-token-key-custody-v1",
  originalActor: authority,
  phase: "reserved",
  plan,
  planDigest: custodyPlanDigest(plan),
  setupGrant,
  version: 1,
});
const packet = {
  request: { action: "enroll-active-v1-key-custody" as const, record, version: 1 as const },
  setup: {
    capturedOwner: {
      adapterGeneration: 1,
      adapterSessionId: "adapter-session",
      authority,
      kind: "direct",
      principal: { ...authority, scopes: ["autograph:start"] },
      sessionId: "session",
    },
    grantRef: "grant",
    operationRef,
    recipient: {
      origin: "https://operator.example/",
      workload: {
        audience: "https://vercel.com/team",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team",
        ownerId: "team",
        projectId: "operator",
        subject: "recipient-subject",
      },
    },
    source: {
      origin: "https://builder.example/",
      workload: {
        audience: "https://vercel.com/team",
        environment: "production",
        issuer: "https://oidc.vercel.com/team",
        ownerId: "team",
        projectId: "builder",
        subject: "source-subject",
      },
    },
    version: 1,
  },
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map(async (directory) => {
      await rm(directory, { force: true, recursive: true });
    }),
  );
});
const requestFile = async (content = JSON.stringify(packet), mode = 0o600) => {
  // oxlint-disable-next-line sonarjs/publicly-writable-directories -- mkdtemp atomically creates an unpredictable owner-only directory; request files are explicitly chmodded.
  const directory = await mkdtemp("/private/tmp/custody-cli-test-");
  directories.push(directory);
  const filename = path.join(directory, "request.json");
  await writeFile(filename, content, { mode });
  await chmod(filename, mode);
  return filename;
};
const run = (args: string[], input = "") =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", path.resolve("lib/provisioning/vercel-token-key-custody-cli.mts"), ...args],
    { encoding: "utf-8", input, timeout: 10_000 },
  );
const expectPrivateFailure = (result: ReturnType<typeof run>) => {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("Custody setup is unavailable or requires reconciliation.\n");
};

describe("private custody enrollment CLI", () => {
  it("plans from a canonical owner-only file and emits only frozen nonsecret digests", async () => {
    const filename = await requestFile();
    const result = run(["plan", "--request-file", filename]);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      approvalRef: record.approvalRef,
      confirmationDigest: custodyEnrollmentDigest(packet.request),
      grantDigest: record.grantDigest,
      grantRef: record.grantRef,
      operationRef,
      planDigest: record.planDigest,
    });
    expect(result.stdout).not.toContain("source-deployment");
    expect(result.stdout).not.toContain("ownerUserId");
  });
  it("rejects group or world readable packets", async () => {
    expectPrivateFailure(run(["plan", "--request-file", await requestFile(undefined, 0o640)]));
  });
  it("rejects a symlink even when its target is owner-only", async () => {
    const filename = await requestFile();
    const linked = path.join(path.dirname(filename), "linked.json");
    await symlink(filename, linked);
    expectPrivateFailure(run(["plan", "--request-file", linked]));
  });
  it("rejects noncanonical or relative paths", async () => {
    const filename = await requestFile();
    expectPrivateFailure(run(["plan", "--request-file", path.relative(process.cwd(), filename)]));
    expectPrivateFailure(
      run([
        "plan",
        "--request-file",
        `${path.dirname(filename)}/../${path.basename(path.dirname(filename))}/request.json`,
      ]),
    );
  });
  it("bounds request files before parsing", async () => {
    expectPrivateFailure(run(["plan", "--request-file", await requestFile("x".repeat(65_537))]));
    expectPrivateFailure(run(["plan", "--request-file", await requestFile("")]));
  });
  it("suppresses malformed and caller-supplied packet details", async () => {
    const marker = "PRIVATE_PACKET_MARKER";
    expectPrivateFailure(
      run([
        "plan",
        "--request-file",
        await requestFile(JSON.stringify({ ...packet, key: marker })),
      ]),
    );
    expectPrivateFailure(run(["plan", "--request-file", await requestFile(`{${marker}`)]));
  });
  it("refuses mismatched setup bindings before showing a confirmation digest", async () => {
    const mismatched = {
      ...packet,
      setup: { ...packet.setup, operationRef: "22222222-2222-4222-8222-222222222222" },
    };
    expectPrivateFailure(
      run(["plan", "--request-file", await requestFile(JSON.stringify(mismatched))]),
    );
  });
  it("requires the private stdin database descriptor and rejects an empty frame before DB access", async () => {
    const filename = await requestFile();
    expectPrivateFailure(run(["enroll", "--request-file", filename, "--database-url-fd", "0"]));
    expectPrivateFailure(
      run(
        ["enroll", "--request-file", filename, "--database-url-fd", "0"],
        "INVALID_PRIVATE_FRAME",
      ),
    );
    const wrongDescriptor = run(["enroll", "--request-file", filename, "--database-url-fd", "3"]);
    expect(wrongDescriptor.status).toBe(1);
    expect(wrongDescriptor.stdout).toBe("");
    expect(wrongDescriptor.stderr).toContain(
      "Expected custody plan --request-file PATH or enroll --request-file PATH --database-url-fd 0.",
    );
  });
});
