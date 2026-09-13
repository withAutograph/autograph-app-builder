import { createHostedEvalSandboxWorker } from "./hosted-self-reproduction-sandbox-worker";
/* oxlint-disable eslint/require-await -- asynchronous provider doubles */
import { expect, it, vi } from "vitest";

vi.mock("@vercel/sandbox", () => ({ Sandbox: {} }));

const fixture = () => {
  const sandbox = {
    getCommand: vi.fn(async () => ({ exitCode: null as number | null })),
    name: "sandbox-1",
    readFileToBuffer: vi.fn(async (): Promise<Buffer | null> => null),
    runCommand: vi.fn(async () => ({ cmdId: "command-1" })),
    stop: vi.fn(async () => {}),
    writeFiles: vi.fn(async (_files: { path: string; content: Buffer }[]) => {}),
  };
  const sdk = { create: vi.fn(async () => sandbox), get: vi.fn(async () => sandbox) };
  const acquireOidc = vi.fn(async () => ({
    expiresAt: 9_999_999_999,
    projectId: "project",
    teamId: "team",
    token: "oidc-secret",
  }));
  const reader = { acquire: vi.fn(async () => ({ token: "read-only-template-token" })) };
  const worker = createHostedEvalSandboxWorker({
    acquireOidc,
    now: () => 1000,
    scope: { environment: "production", projectId: "project", teamId: "team" },
    sdk: sdk as never,
    templateReader: reader,
  });
  return { acquireOidc, reader, sandbox, sdk, worker };
};
it("creates the fixed public source and detached trusted bootstrap without passing App credentials", async () => {
  const f = fixture();
  const result = await f.worker.start({
    cleanupAt: 10_000,
    operationId: "operation",
    workload: "self-reproduction/v1",
  });
  expect(f.sdk.create).toHaveBeenCalledWith(
    expect.objectContaining({
      networkPolicy: "allow-all",
      persistent: false,
      source: {
        revision: "main",
        type: "git",
        url: "https://github.com/withAutograph/autograph-app-builder.git",
      },
    }),
  );
  expect(f.sandbox.runCommand).toHaveBeenCalledWith(
    expect.objectContaining({ cmd: "node", detached: true }),
  );
  expect(JSON.stringify(f.sandbox.writeFiles.mock.calls)).not.toContain("read-only-template-token");
  expect(JSON.stringify(result)).not.toContain("oidc-secret");
  expect(await f.worker.find("operation")).toBeUndefined();
});
it("reacquires project identity for polling and restricts artifact reads to fixed IDs", async () => {
  const f = fixture();
  const { workerId } = await f.worker.start({
    cleanupAt: 10_000,
    operationId: "operation",
    workload: "self-reproduction/v1",
  });
  f.sandbox.readFileToBuffer.mockResolvedValueOnce(
    Buffer.from(
      JSON.stringify({
        artifacts: [{ contentType: "text/plain", id: "worker.log" }],
        status: "failed",
      }),
    ),
  );
  f.acquireOidc.mockResolvedValueOnce({
    expiresAt: 9_999_999_999,
    projectId: "project",
    teamId: "team",
    token: "refreshed-oidc",
  });
  const result = await f.worker.inspect(workerId);
  expect(result.status).toBe("failed");
  const refreshFiles = f.sandbox.writeFiles.mock.calls.at(-1)?.[0] as unknown as {
    path: string;
    content: Buffer;
  }[];
  expect(JSON.parse(refreshFiles[0].content.toString()).token).toBe("refreshed-oidc");
  expect(f.acquireOidc).toHaveBeenCalledTimes(2);
  expect(f.sandbox.writeFiles).toHaveBeenLastCalledWith([
    expect.objectContaining({
      content: expect.any(Buffer),
      path: "/tmp/self-reproduction-identity.json",
    }),
  ]);
  await expect(f.worker.readArtifact(workerId, "../.env")).rejects.toThrow("unavailable");
  expect(f.acquireOidc).toHaveBeenCalledTimes(2);
  f.sandbox.readFileToBuffer.mockResolvedValueOnce(Buffer.from("diagnostic"));
  expect(await f.worker.readArtifact(workerId, "worker.log")).toEqual(Buffer.from("diagnostic"));
  await f.worker.stop(workerId);
  expect(f.acquireOidc).toHaveBeenCalledTimes(4);
  expect(f.sandbox.stop).toHaveBeenCalledOnce();
});
it("rejects manifests listing source or secret paths and reports ended workers without receipts failed", async () => {
  const f = fixture();
  const id = JSON.stringify({ commandId: "command-1", sandboxName: "sandbox-1" });
  f.sandbox.readFileToBuffer.mockResolvedValueOnce(
    Buffer.from(
      JSON.stringify({
        artifacts: [{ contentType: "text/plain", id: ".env.local" }],
        status: "completed",
      }),
    ),
  );
  await expect(f.worker.inspect(id)).rejects.toThrow("allowlist");
  f.sandbox.getCommand.mockResolvedValueOnce({ exitCode: 1 });
  expect(await f.worker.inspect(id)).toEqual({ artifacts: [], status: "failed" });
});
it("stops an acquired sandbox if detached bootstrap launch fails", async () => {
  const f = fixture();
  f.sandbox.runCommand.mockRejectedValue(new Error("provider failure"));
  await expect(
    f.worker.start({
      cleanupAt: 10_000,
      operationId: "operation",
      workload: "self-reproduction/v1",
    }),
  ).rejects.toThrow("launch failed");
  expect(f.sandbox.stop).toHaveBeenCalledOnce();
});
