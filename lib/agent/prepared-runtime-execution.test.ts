/* oxlint-disable eslint/require-await, sonarjs/no-hardcoded-passwords -- Only synthetic SDK fixtures run. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type {
  PreparedRuntimeExecutionDependencies,
  RuntimeTransport,
} from "./prepared-runtime-execution";
import {
  resolvePreparedRuntimeExecution,
  restorePreparedRuntimeExecution,
  runtimeFilesForOrigin,
} from "./prepared-runtime-execution";
import { HostedRuntimeProviderError } from "../provisioning/hosted-runtime-provider";

const mocks = {
  assertAuthority: vi.fn<PreparedRuntimeExecutionDependencies["assertAuthority"]>(),
  getProvider: vi.fn<PreparedRuntimeExecutionDependencies["getProvider"]>(),
  observeInstallation: vi.fn<PreparedRuntimeExecutionDependencies["observeInstallation"]>(),
  readBinding: vi.fn<PreparedRuntimeExecutionDependencies["readBinding"]>(),
};

const proof = {
  actors: 8,
  appId: "spend-review",
  artifactHash: "a".repeat(64),
  authenticatedBehavior: "unassessed" as const,
  environment: "preview",
  releaseId: "release_1",
  tenants: 2,
};
const descriptor = {
  app: { id: "spend-review", routes: [], workspacePath: "apps/spend-review" },
  backend: {
    authorization: "declared-policy",
    kind: "generated-postgres",
    release: {
      artifactHash: `sha256:${proof.artifactHash}`,
      directory: "release",
      id: proof.releaseId,
    },
    roles: ["requester", "reviewer"],
    runtime: { databaseEnvironment: "SPEND_REVIEW_DATABASE_URL" },
    schemaReceipt: null,
  },
  validation: {
    browser: { task: "test-e2e" },
    check: { task: "check" },
    test: { shards: 1, task: "test" },
  },
  version: 1,
};
const files = () => ({
  "environment.json": JSON.stringify({
    APP_TEST_BASE_URL: "https://old.vercel.run",
    BETTER_AUTH_SECRET: "synthetic-auth-secret",
    BETTER_AUTH_URL: "https://old.vercel.run",
    PLATFORM_AUTH_DATABASE_URL:
      "postgres://restricted:synthetic@ep-owner.neon.tech/auth?sslmode=verify-full",
  }),
  "identities.json": JSON.stringify({
    identities: [{ actorId: "requester", storageState: "/private-state/requester.storage.json" }],
  }),
  "requester.storage.json": JSON.stringify({
    cookies: [
      {
        domain: "old.vercel.run",
        name: "session",
        path: "/",
        secure: true,
        value: "synthetic-session-token",
      },
    ],
    origins: [{ localStorage: [], origin: "https://old.vercel.run" }],
  }),
  "state.json": JSON.stringify({
    clusterUrl: "private-installer-url",
    plan: {
      appId: "spend-review",
      environment: "preview",
      roles: ["requester", "reviewer"],
      runtimeId: "runtime_owned",
    },
  }),
});
const binding = () => ({
  branch: "builder/spend-review",
  environment: z.record(z.string(), z.string()).parse(JSON.parse(files()["environment.json"])),
  files: files(),
  persistFiles: vi.fn(),
  projectId: "prj_owned",
  stateDirectory: "/private-state",
});
const transport = (description = descriptor, chunks = ["8 passed synthetic-auth-secret"]) => {
  const close = vi.fn();
  const logs = Object.assign(
    async function* logs() {
      for (const data of chunks) {
        yield { data, stream: "stdout" as const };
      }
    },
    { close },
  );
  const command = {
    exitCode: 0,
    kill: vi.fn(),
    logs: () => Object.assign(logs(), { close }),
    stdout: async () => "",
    wait: async () => ({ exitCode: 0 }),
  };
  const runCommand = vi
    .fn<RuntimeTransport["runCommand"]>()
    .mockResolvedValueOnce({
      ...command,
      exitCode: 0,
      stdout: async () => JSON.stringify(description),
    })
    .mockResolvedValue(command);
  return {
    close,
    command,
    provider: { fs: { mkdir: vi.fn(), rm: vi.fn() }, runCommand, writeFiles: vi.fn() },
  };
};
const context = {
  appId: "spend-review",
  root: "/workspace/repository",
  sandboxId: "sandbox_replacement",
  sessionAuth: {},
  sessionId: "session_1",
  state: { phase: "empty", version: 17 },
};
const selection = {
  appId: context.appId,
  branch: "builder/spend-review",
  projectId: "prj_owned",
  sessionId: context.sessionId,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.observeInstallation.mockResolvedValue({
    actors: proof.actors,
    artifactHash: proof.artifactHash,
    authenticatedBehavior: proof.authenticatedBehavior,
    releaseId: proof.releaseId,
    tenants: proof.tenants,
  });
});

describe("approved hosted runtime consumers", () => {
  it("never falls back to legacy credential decryption when the operator is unavailable", async () => {
    const operatorClient = vi.fn(() => {
      throw new Error("protected_operator_required");
    });
    await expect(
      resolvePreparedRuntimeExecution(
        context,
        { ...selection, operationRef: "11111111-1111-4111-8111-111111111111" },
        { ...mocks, operatorClient },
      ),
    ).rejects.toThrow("protected_operator_required");
    expect(mocks.readBinding).not.toHaveBeenCalled();
    expect(mocks.observeInstallation).not.toHaveBeenCalled();
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });

  it("redacts a session token split across provider log chunks before durable output", async () => {
    const fixture = transport(descriptor, [
      "Authenticated ",
      "synthetic-session-",
      "token result\n",
    ]);
    const runtime = await restorePreparedRuntimeExecution({
      appId: context.appId,
      binding: binding(),
      observeInstallation: async () =>
        await mocks.observeInstallation({
          ...context,
          files: files(),
          stateDirectory: "/private-state",
        }),
      provider: fixture.provider,
      root: context.root,
    });
    const onChunk = vi.fn();
    const result = await runtime.runTask({ onChunk, task: "test-e2e" });
    expect(result.stdout).toBe("Authenticated [REDACTED] result\n");
    expect(JSON.stringify(onChunk.mock.calls)).not.toContain("synthetic-session-");
  });
  it("restores replacement Sandbox state, verifies the installed source release, and runs using SDK env", async () => {
    const fixture = transport();
    const original = binding();
    mocks.readBinding.mockResolvedValue(original);
    mocks.getProvider.mockResolvedValue(fixture.provider);
    const runtime = await resolvePreparedRuntimeExecution(context, selection, mocks);
    expect(fixture.provider.writeFiles).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ mode: 0o600, path: "/private-state/environment.json" }),
      ]),
      expect.anything(),
    );
    expect(JSON.stringify(fixture.provider.writeFiles.mock.calls)).not.toContain(
      "private-installer-url",
    );
    expect(JSON.stringify(fixture.provider.writeFiles.mock.calls)).not.toContain("state.json");
    expect(fixture.provider.fs.rm).toHaveBeenCalledWith(
      "/private-state/state.json",
      expect.objectContaining({ force: true }),
    );
    expect(mocks.observeInstallation).toHaveBeenCalledWith(
      expect.objectContaining({ files: original.files, sandboxId: context.sandboxId }),
    );
    expect(runtime?.installationProof).toMatchObject({
      ...proof,
      branch: selection.branch,
      observation: "database-verification",
    });
    expect(runtime?.installationProof.observedAt).toMatch(/^\d{4}-/u);
    const onChunk = vi.fn();
    const result = await runtime?.runTask({ onChunk, task: "test-e2e" });
    expect(result).toMatchObject({ exitCode: 0, stdout: "8 passed [REDACTED]" });
    expect(onChunk).toHaveBeenCalledWith("stdout", "8 passed [REDACTED]");
    expect(fixture.provider.runCommand).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: ["run", "app:runtime", "run", "spend-review", "test-e2e"],
        env: { APP_RUNTIME_STATE_DIR: "/private-state" },
      }),
    );
    expect(JSON.stringify(fixture.provider.runCommand.mock.calls)).not.toContain(
      "synthetic-auth-secret",
    );
    expect(fixture.close).toHaveBeenCalled();
  });
  it("persists only an updated browser origin and cookies without preparing the database again", async () => {
    const fixture = transport();
    const original = binding();
    const runtime = await restorePreparedRuntimeExecution({
      appId: context.appId,
      binding: original,
      observeInstallation: async () =>
        await mocks.observeInstallation({
          ...context,
          files: files(),
          stateDirectory: "/private-state",
        }),
      provider: fixture.provider,
      root: context.root,
    });
    await runtime.prepareAuthenticatedOrigin("https://new-gateway.vercel.run");
    const saved = z.record(z.string(), z.string()).parse(original.persistFiles.mock.calls[0]?.[0]);
    expect(saved["state.json"]).toBe(original.files["state.json"]);
    expect(saved["requester.storage.json"]).toContain("synthetic-session-token");
    expect(
      z
        .object({ cookies: z.array(z.object({ domain: z.string() })) })
        .parse(JSON.parse(saved["requester.storage.json"])).cookies[0]?.domain,
    ).toBe("new-gateway.vercel.run");
    expect(
      z.record(z.string(), z.string()).parse(JSON.parse(saved["environment.json"])).BETTER_AUTH_URL,
    ).toBe("https://new-gateway.vercel.run");
    expect(fixture.provider.runCommand).toHaveBeenCalledTimes(1);
    expect(() => runtimeFilesForOrigin(original.files, "https://unowned.example")).toThrow();
  });
  it("blocks a changed selected release rather than reporting journal metadata as installation proof", async () => {
    const fixture = transport({
      ...descriptor,
      backend: {
        ...descriptor.backend,
        release: { ...descriptor.backend.release, id: "release_2" },
      },
    });
    await expect(
      restorePreparedRuntimeExecution({
        appId: context.appId,
        binding: binding(),
        observeInstallation: async () =>
          await mocks.observeInstallation({
            ...context,
            files: files(),
            stateDirectory: "/private-state",
          }),
        provider: fixture.provider,
        root: context.root,
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });
  it.each(["authorization_required", "connection_required"] as const)(
    "never downgrades an approved %s failure to local data",
    async (code) => {
      mocks.readBinding.mockRejectedValue(new HostedRuntimeProviderError(code));
      await expect(
        resolvePreparedRuntimeExecution(context, selection, mocks),
      ).rejects.toMatchObject({
        code,
      });
      expect(mocks.getProvider).not.toHaveBeenCalled();
    },
  );
  it("does not prepare a local database when an approved binding is missing", async () => {
    mocks.readBinding.mockResolvedValue(null);
    await expect(resolvePreparedRuntimeExecution(context, selection, mocks)).rejects.toMatchObject({
      code: "connection_required",
    });
  });
  it("preserves static/local consumers with no hosted selection", async () => {
    expect(await resolvePreparedRuntimeExecution(context, null, mocks)).toBeNull();
    expect(mocks.readBinding).not.toHaveBeenCalled();
  });
  it("supports the selected source branch for earlier journal records", async () => {
    const state = {
      ...context.state,
      githubSource: { resolvedRef: "refs/heads/selected-preview" },
    };
    mocks.readBinding.mockResolvedValue(null);
    expect(await resolvePreparedRuntimeExecution({ ...context, state }, null, mocks)).toBeNull();
    expect(mocks.readBinding).toHaveBeenCalledWith(
      expect.objectContaining({
        branch: "selected-preview",
        optionalProject: true,
        sessionId: context.sessionId,
      }),
    );
  });
  it("preserves an earlier approved source-branch blocker when Eve selection metadata is absent", async () => {
    const state = {
      ...context.state,
      githubSource: { resolvedRef: "refs/heads/selected-preview" },
    };
    mocks.readBinding.mockRejectedValue(new HostedRuntimeProviderError("connection_required"));
    await expect(
      resolvePreparedRuntimeExecution({ ...context, state }, null, mocks),
    ).rejects.toMatchObject({ code: "connection_required" });
    expect(mocks.getProvider).not.toHaveBeenCalled();
  });
  it("rejects a runtime selection owned by another session", async () => {
    await expect(
      resolvePreparedRuntimeExecution(
        context,
        { ...selection, sessionId: "another_session" },
        mocks,
      ),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(mocks.readBinding).not.toHaveBeenCalled();
  });
});
