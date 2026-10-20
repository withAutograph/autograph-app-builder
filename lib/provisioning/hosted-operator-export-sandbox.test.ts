/* oxlint-disable eslint/require-await -- Public SDK adapters are controlled in-memory fixtures; no Sandbox or provider is created. */
import { runInNewContext } from "node:vm";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createTenantExportSandbox } from "./hosted-operator-export-sandbox";
import { tenantExportWireFixtureSchema } from "./hosted-operator-export-contract";
import wire from "./fixtures/tenant-export-wire-v1.json";

const sdk = { create: vi.fn(), get: vi.fn(), token: vi.fn() };

const fixture = tenantExportWireFixtureSchema.parse(wire);
const metadata = new Map<string, Buffer>();
let commandTerminal = true;
let dispatchUnknown = false;
const command = {
  stdout: async () => "",
  cmdId: "command-one",
  exitCode: 0,
  wait: vi.fn(async () => ({ exitCode: 0 })),
};
const runCommand = vi.fn(
  async (input: {
    cmd: string;
    args?: string[];
    env?: Record<string, string>;
    detached?: boolean;
  }) => {
    if (input.cmd === "sha256sum") {
      return {
        ...command,
        exitCode: 0,
        stdout: async () => `${fixture.descriptor.sha256}  executable\\n`,
      };
    }
    if (input.cmd === "node") {
      const args = input.args ?? [];
      const script = args[1];
      const target = args[2];
      const content = args[3];
      if (script === undefined || target === undefined || content === undefined) {
        throw new Error("Missing fixed metadata arguments");
      }
      const fs = {
        mkdirSync: vi.fn(),
        lstatSync: (value: string) => ({
          isDirectory: () => value !== target,
          isFile: () => value === target,
          isSymbolicLink: () => false,
          uid: 500,
          mode: value === target ? 0o600 : 0o700,
        }),
        openSync: (value: string, flags: string, mode: number) => {
          expect(flags).toBe("wx");
          expect(mode).toBe(0o600);
          if (metadata.has(value)) {
            throw Object.assign(new Error("exists"), { code: "EEXIST" });
          }
          return value;
        },
        writeFileSync: (handle: string, value: string) => {
          metadata.set(handle, Buffer.from(value));
        },
        fsyncSync: vi.fn(),
        closeSync: vi.fn(),
        readFileSync: (value: string) => metadata.get(value)?.toString("utf-8"),
      };
      // oxlint-disable-next-line sonarjs/code-eval -- Execute only the source-owned fixed metadata writer against a virtual filesystem, never app code.
      runInNewContext(script, {
        require: (module: string) => (module === "node:fs" ? fs : path),
        process: {
          argv: ["node", target, content],
          getuid: () => 500,
          exit: (code: number) => {
            if (code !== 0) {
              throw new Error("invalid private metadata");
            }
          },
        },
      });
      return { ...command, exitCode: 0 };
    }
    if (dispatchUnknown) {
      throw new Error("private transport acknowledgement unavailable");
    }
    return command;
  },
);
const sandbox = {
  name: "private-vm",
  runCommand,
  delete: vi.fn(async () => {}),
  extendTimeout: vi.fn(async () => {}),
  readFileToBuffer: vi.fn(async (input: { path: string }) =>
    input.path.endsWith("manifest.json")
      ? Buffer.from("private manifest")
      : (metadata.get(input.path) ?? null),
  ),
  readFile: vi.fn(async () => null),
  getCommand: vi.fn(async () => ({ ...command, exitCode: commandTerminal ? 0 : null })),
};
const launcher = () =>
  createTenantExportSandbox(
    {
      image: "trusted-image",
      projectId: "operator-project",
      teamId: "operator-team",
      exportWorker: fixture.descriptor,
    },
    sdk,
  );
beforeEach(() => {
  vi.clearAllMocks();
  metadata.clear();
  commandTerminal = true;
  dispatchUnknown = false;
  sdk.create.mockResolvedValue(sandbox);
  sdk.get.mockResolvedValue(sandbox);
  sdk.token.mockResolvedValue("host-only-oidc");
});
describe("fixed tenant export Sandbox transport", () => {
  it("creates exclusive private metadata and confines the migrator credential to the fixed command environment", async () => {
    const executor = launcher();
    const assertCurrent = vi.fn(async () => {});
    const locator = await executor.prepare(fixture.worker, assertCurrent);
    const checkpoint = vi.fn(async () => {});
    const credential = "postgres://app-migrator:synthetic-password@private.test/app";
    await executor.run(fixture.worker, locator, credential, assertCurrent, checkpoint);
    expect(sdk.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ports: [],
        persistent: false,
        networkPolicy: "allow-all",
        env: {},
      }),
    );
    const actual = runCommand.mock.calls.at(-1)?.[0];
    expect(actual?.cmd).toBe(fixture.descriptor.executablePath);
    expect(actual?.args).toEqual([
      fixture.descriptor.subcommand,
      "--file-spool",
      `/tmp/autograph-tenant-export-input/${fixture.worker.exportId}/${fixture.worker.attemptId}.json`,
    ]);
    expect(actual?.env).toEqual({ AUTOGRAPH_TENANT_EXPORT_APP_MIGRATOR_URL: credential });
    expect(
      JSON.stringify([...metadata.values()].map((value) => value.toString("utf-8"))),
    ).not.toContain(credential);
    expect(checkpoint).toHaveBeenCalledWith({ ...locator, commandId: "command-one" });
  });
  it("does not label a missing command acknowledgement or still-running command terminal", async () => {
    const executor = launcher();
    const locator = await executor.prepare(fixture.worker, async () => {});
    expect(await executor.inspect(fixture.worker, locator)).toEqual({ status: "unknown" });
    commandTerminal = false;
    expect(
      await executor.inspect(fixture.worker, { ...locator, commandId: "command-one" }),
    ).toEqual({ status: "unknown" });
    expect(runCommand).toHaveBeenCalledTimes(2);
  });
  it("preserves uncertain command dispatch without inventing a command identity or retrying it", async () => {
    const executor = launcher();
    const locator = await executor.prepare(fixture.worker, async () => {});
    const checkpoint = vi.fn(async () => {});
    dispatchUnknown = true;
    await expect(
      executor.run(fixture.worker, locator, "private-credential", async () => {}, checkpoint),
    ).rejects.toThrow("acknowledgement");
    expect(checkpoint).not.toHaveBeenCalled();
    expect(runCommand).toHaveBeenCalledTimes(3);
  });
});
