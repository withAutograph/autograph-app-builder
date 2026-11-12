/* oxlint-disable typescript/no-unsafe-type-assertion -- Preserve the existing test fixtures and asserted runtime boundaries. */
import { describe, expect, it, vi } from "vitest";
import type { SandboxSession } from "eve/sandbox";
import type { ApplyCommandExecutor } from "../repository/target-apply";

import {
  assertExistingAppImplementationFiles,
  implementationArchitectureDiagnostics,
  implementationFilesSchema,
  applyImplementationFiles,
  withImplementationFiles,
} from "./apply-implementation-files";

const unexpectedSandboxOperation = () => {
  throw new Error("Unexpected sandbox operation");
};

const sandboxWithWriter = (writeTextFile: SandboxSession["writeTextFile"]): SandboxSession => ({
  readFile: unexpectedSandboxOperation,
  readBinaryFile: unexpectedSandboxOperation,
  readTextFile: unexpectedSandboxOperation,
  writeFile: unexpectedSandboxOperation,
  writeBinaryFile: unexpectedSandboxOperation,
  writeTextFile,
  run: unexpectedSandboxOperation,
  spawn: unexpectedSandboxOperation,
  removePath: unexpectedSandboxOperation,
  resolvePath: unexpectedSandboxOperation,
});

const scaffoldAppId = "example";
const scaffoldWorkspace = `apps/${scaffoldAppId}`;
const scaffoldCue = `.config/app-specs/${scaffoldAppId}.cue`;
const appCue = `${scaffoldWorkspace}/schema/${scaffoldAppId}.cue`;
const manifest = `${scaffoldWorkspace}/package.json`;
const nextConfig = `${scaffoldWorkspace}/next.config.ts`;
const nextJavaScriptConfig = `${scaffoldWorkspace}/next.config.js`;
const nextModuleConfig = `${scaffoldWorkspace}/next.config.mjs`;
const proxy = `${scaffoldWorkspace}/proxy.ts`;
const protectedConfig = `${scaffoldWorkspace}/app/data/protected-config.ts`;
const protectedContext = `${scaffoldWorkspace}/app/data/context.ts`;
const queries = `${scaffoldWorkspace}/app/data/queries.ts`;
const appPage = `${scaffoldWorkspace}/app/page.tsx`;
const appSpec = { path: "prototype/example/app-spec.md", sha256: "a".repeat(64) };
const commandSucceeded = { exitCode: 0, stderr: "", stdout: "scaffold receipt" };
const scaffoldProposal: Parameters<ApplyCommandExecutor>[0]["proposal"] = {
  blockers: [],
  contract: { appId: scaffoldAppId, appSpec, version: 1 },
  mutations: [],
  plan: {
    product: { appSpec },
    source: {
      packageName: "@autograph/example",
      runtime: "nextjs",
      schema: { kind: "none" },
      workspacePath: scaffoldWorkspace,
    },
    topology: {
      configPath: "microfrontends.json",
      packageName: "@autograph/example",
      projectName: "apps-example",
      routes: ["/example", "/example/:path*"],
    },
  },
};

const scaffoldSandbox = () => {
  const files = new Map<string, string>();
  const read = (path: string) => files.get(`repository/${path}`);
  const write = (path: string, content: string) => files.set(`repository/${path}`, content);
  const sandbox: SandboxSession = {
    ...sandboxWithWriter(async ({ path, content }) => {
      files.set(path, content);
      await Promise.resolve();
    }),
    readBinaryFile: async ({ path }) => {
      const content = files.get(path);
      return await Promise.resolve(content === undefined ? null : Buffer.from(content));
    },
    readTextFile: async ({ path }) => await Promise.resolve(files.get(path) ?? null),
    writeBinaryFile: async ({ path, content }) => {
      files.set(path, Buffer.from(content).toString("utf-8"));
      await Promise.resolve();
    },
    removePath: async ({ path }) => {
      files.delete(path);
      await Promise.resolve();
    },
    run: vi.fn<SandboxSession["run"]>().mockResolvedValue(commandSucceeded),
  };
  const apply = async (
    executor: ApplyCommandExecutor,
    changes: Parameters<typeof withImplementationFiles>[1],
  ) =>
    await withImplementationFiles(executor, changes, { reconcileNewWorkspace: true })({
      appId: scaffoldAppId,
      applyRoot: "/workspace/repository",
      proposal: scaffoldProposal,
      sandbox,
    });
  return { apply, read, write };
};

describe("approval-bound implementation files", () => {
  it.each(["app-local", "scaffold"] as const)(
    "generates and retains protected runtime files before product apply from a %s CUE",
    async (form) => {
      const fixture = scaffoldSandbox();
      const source = form === "app-local" ? appCue : scaffoldCue;
      const submittedCue = "package inventory\n";
      const generatedCue = "package inventory\n\n";
      const generatedProxy = "export const proxy = createProtectedNextProxy(verification);";
      const generatedTracing = "export default nextAppConfig({ outputFileTracingIncludes });";
      const generatedBoundary = "export function readProtectedAppBoundary() {}";
      const generatedContext = "export const context = readVerifiedNextAppSession();";
      const runGenerator: ApplyCommandExecutor = async () => {
        expect(fixture.read(scaffoldCue)).toBe(submittedCue);
        expect(fixture.read(appCue)).toBeUndefined();
        fixture.write(appCue, generatedCue);
        fixture.write(proxy, generatedProxy);
        fixture.write(nextConfig, generatedTracing);
        fixture.write(protectedConfig, generatedBoundary);
        fixture.write(protectedContext, generatedContext);
        fixture.write(
          manifest,
          JSON.stringify({
            dependencies: {
              "@autograph/generated-app-runtime": "workspace:*",
              "@autograph/platform-microfrontends": "workspace:*",
            },
            devDependencies: { "@autograph/next-config": "workspace:*" },
          }),
        );
        return await Promise.resolve(commandSucceeded);
      };
      await expect(
        fixture.apply(runGenerator, [
          { path: source, content: submittedCue },
          { path: proxy, operation: "delete" },
          { path: nextConfig, content: "export default nextAppConfig();" },
          { path: nextJavaScriptConfig, content: "module.exports = {};" },
          { path: nextModuleConfig, content: "export default {};" },
          { path: protectedConfig, content: "export const bypass = true;" },
          { path: protectedContext, operation: "delete" },
          { path: queries, content: "export const readInventory = async () => [];" },
          { path: appPage, content: "export default function Page() { return 'Inventory'; }" },
          { path: manifest, content: '{"dependencies":{"server-only":"catalog:"}}' },
        ]),
      ).resolves.toEqual(commandSucceeded);
      expect(fixture.read(scaffoldCue)).toBe(form === "app-local" ? undefined : submittedCue);
      expect(fixture.read(appCue)).toBe(generatedCue);
      expect(fixture.read(proxy)).toBe(generatedProxy);
      expect(fixture.read(nextConfig)).toBe(generatedTracing);
      expect(fixture.read(nextJavaScriptConfig)).toBeUndefined();
      expect(fixture.read(nextModuleConfig)).toBeUndefined();
      expect(fixture.read(protectedConfig)).toBe(generatedBoundary);
      expect(fixture.read(protectedContext)).toBe(generatedContext);
      expect(fixture.read(queries)).toContain("readInventory");
      expect(fixture.read(appPage)).toContain("Inventory");
      expect(JSON.parse(fixture.read(manifest) ?? "{}")).toMatchObject({
        dependencies: {
          "@autograph/generated-app-runtime": "workspace:*",
          "@autograph/platform-microfrontends": "workspace:*",
          "server-only": "catalog:",
        },
        devDependencies: { "@autograph/next-config": "workspace:*" },
      });
    },
  );

  it("restores the existing scaffold CUE when the generator fails", async () => {
    const fixture = scaffoldSandbox();
    fixture.write(scaffoldCue, "package previous\n");
    const failure = { exitCode: 1, stderr: "invalid CUE", stdout: "" };
    const runGenerator: ApplyCommandExecutor = async () => {
      expect(fixture.read(scaffoldCue)).toBe("package invalid\n");
      return await Promise.resolve(failure);
    };
    await expect(
      fixture.apply(runGenerator, [
        { path: appCue, content: "package invalid\n" },
        { path: appPage, content: "Unapplied product page" },
      ]),
    ).resolves.toEqual(failure);
    expect(fixture.read(scaffoldCue)).toBe("package previous\n");
    expect(fixture.read(appCue)).toBeUndefined();
    expect(fixture.read(appPage)).toBeUndefined();
  });

  it("compiles the app-local schema when both forms are supplied and retains the authored root file", async () => {
    const fixture = scaffoldSandbox();
    const localCue = "package app_local\n";
    const rootCue = "package authored_root\n";
    const runGenerator: ApplyCommandExecutor = async () => {
      expect(fixture.read(scaffoldCue)).toBe(localCue);
      return await Promise.resolve(commandSucceeded);
    };
    await expect(
      fixture.apply(runGenerator, [
        { path: scaffoldCue, content: rootCue },
        { path: appCue, content: localCue },
      ]),
    ).resolves.toEqual(commandSucceeded);
    expect(fixture.read(scaffoldCue)).toBe(rootCue);
    expect(fixture.read(appCue)).toBe(localCue);
  });

  it.each(["static", "custom"] as const)(
    "keeps authored config and proxy for a %s generator without the protected foundation",
    async (kind) => {
      const fixture = scaffoldSandbox();
      const runGenerator: ApplyCommandExecutor = async () => {
        fixture.write(nextConfig, "generated config");
        fixture.write(proxy, "generated proxy");
        if (kind === "custom") {
          fixture.write(appCue, "package custom_generator\n");
        }
        return await Promise.resolve(commandSucceeded);
      };
      const changes: Parameters<typeof withImplementationFiles>[1][number][] = [
        { path: nextConfig, content: "authored config" },
        { path: nextModuleConfig, content: "authored module config" },
        { path: proxy, content: "authored proxy" },
      ];
      if (kind === "custom") {
        changes.push({ path: appCue, content: "package custom\n" });
      }
      await expect(fixture.apply(runGenerator, changes)).resolves.toEqual(commandSucceeded);
      expect(fixture.read(nextConfig)).toBe("authored config");
      expect(fixture.read(nextModuleConfig)).toBe("authored module config");
      expect(fixture.read(proxy)).toBe("authored proxy");
      if (kind === "custom") {
        expect(fixture.read(appCue)).toBe("package custom\n");
      }
    },
  );

  it("retains a JavaScript config when a protected generator emitted no TypeScript config", async () => {
    const fixture = scaffoldSandbox();
    const runGenerator: ApplyCommandExecutor = async () => {
      fixture.write(protectedConfig, "export function readProtectedAppBoundary() {} ");
      return await Promise.resolve(commandSucceeded);
    };
    await expect(
      fixture.apply(runGenerator, [
        { path: scaffoldCue, content: "package custom\n" },
        { path: nextJavaScriptConfig, content: "module.exports = { custom: true };" },
      ]),
    ).resolves.toEqual(commandSucceeded);
    expect(fixture.read(nextJavaScriptConfig)).toBe("module.exports = { custom: true };");
  });

  it("writes validated files into the successful apply overlay only", async () => {
    const files = implementationFilesSchema.parse([
      {
        content: "export default null",
        path: "apps/stock-exceptions/app/page.tsx",
      },
      {
        content: "export async function POST() { return Response.json({ saved: true }); }",
        path: "apps/stock-exceptions/app/api/drafts/route.ts",
      },
      { content: "export const worker = true;", path: "apps/stock-exceptions/server/worker.mts" },
      {
        content: "CREATE TABLE drafts (id text PRIMARY KEY);",
        path: "apps/stock-exceptions/db/migrations/001.sql",
      },
      { content: "export const proxy = customIngress;", path: "apps/stock-exceptions/proxy.ts" },
      { content: "export default {};", path: "apps/stock-exceptions/next.config.mjs" },
    ]);
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const writeTextFile = vi.fn(() => Promise.resolve());
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const executor = vi.fn(() =>
      Promise.resolve({
        exitCode: 0,
        stderr: "",
        stdout: "receipt",
      }),
    );
    const wrapped = withImplementationFiles(executor, files);

    await expect(
      wrapped({
        appId: "stock-exceptions",
        applyRoot: "/workspace/repository",
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
        proposal: {
          operation: "iterate-existing-app",
          plan: { source: { workspacePath: "apps/stock-exceptions" } },
        } as never,
        sandbox: sandboxWithWriter(writeTextFile),
      }),
    ).resolves.toEqual({ exitCode: 0, stderr: "", stdout: "receipt" });

    expect(writeTextFile).toHaveBeenCalledWith({
      content: "export default null",
      path: "repository/apps/stock-exceptions/app/page.tsx",
    });
    for (const [index, file] of files.entries()) {
      expect(writeTextFile).toHaveBeenNthCalledWith(index + 1, {
        content: file.content,
        path: `repository/${file.path}`,
      });
    }
    expect(
      implementationFilesSchema.safeParse([{ content: "nope", path: "../outside.ts" }]).success,
    ).toBe(false);
  });

  it("rejects out-of-app implementation files before applying an existing-app change", async () => {
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const writeTextFile = vi.fn(() => Promise.resolve());
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const executor = vi.fn(() => Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }));
    const wrapped = withImplementationFiles(executor, [
      { content: "out of scope", path: "packages/platform/src/change.ts" },
    ]);

    await expect(
      wrapped({
        appId: "inventory-queue",
        applyRoot: "/workspace/repository",
        // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
        proposal: {
          operation: "iterate-existing-app",
          plan: { source: { workspacePath: "apps/inventory-queue" } },
        } as never,
        sandbox: sandboxWithWriter(writeTextFile),
      }),
    ).rejects.toThrow("Existing-app implementation files must stay inside the app workspace.");
    expect(executor).not.toHaveBeenCalled();
    expect(writeTextFile).not.toHaveBeenCalled();
  });

  it("rejects an out-of-app validation repair before it can write", () => {
    const proposal = {
      operation: "iterate-existing-app" as const,
      plan: { source: { workspacePath: "apps/inventory-queue" } },
    };
    expect(() => {
      assertExistingAppImplementationFiles(
        [{ content: "out of scope", path: "packages/platform/src/change.ts" }],
        proposal,
      );
    }).toThrow("Existing-app implementation files must stay inside the app workspace.");
    expect(() => {
      assertExistingAppImplementationFiles(
        [{ content: "in scope", path: "apps/inventory-queue/app/page.tsx" }],
        proposal,
      );
    }).not.toThrow();
  });
  it("applies explicit removal non-recursively and retries an absent file safely", async () => {
    const sandbox = {
      removePath: vi.fn<() => Promise<void>>().mockResolvedValue(),
      writeTextFile: vi.fn<() => Promise<void>>().mockResolvedValue(),
    };
    const files = implementationFilesSchema.parse([
      { operation: "delete", path: "apps/example/server/demo.ts" },
      { content: "authenticated context", path: "apps/example/server/context.ts" },
    ]);
    await applyImplementationFiles(sandbox, "/workspace/repository", files);
    await applyImplementationFiles(sandbox, "/workspace/repository", files);
    expect(sandbox.removePath).toHaveBeenCalledWith({
      force: true,
      path: "repository/apps/example/server/demo.ts",
    });
    expect(sandbox.writeTextFile).toHaveBeenCalledWith({
      content: "authenticated context",
      path: "repository/apps/example/server/context.ts",
    });
    expect(sandbox.removePath).toHaveBeenCalledTimes(2);
  });
  it("rejects escaping removal paths and duplicate mixed operations", () => {
    for (const path of [
      "../outside",
      "/outside",
      "apps//example",
      "apps/\0example",
      "apps/example/.",
    ]) {
      expect(implementationFilesSchema.safeParse([{ operation: "delete", path }]).success).toBe(
        false,
      );
    }
    expect(
      implementationFilesSchema.safeParse([
        { operation: "delete", path: "apps/example/file.ts" },
        { content: "replacement", path: "apps/example/file.ts" },
      ]).success,
    ).toBe(false);
  });

  it("reports submission heuristics without blocking apply", () => {
    expect(
      implementationArchitectureDiagnostics(
        [
          {
            content:
              '"use client"; localStorage.setItem("draft", "value"); export default function Page() { return null; }',
            path: "app/page.tsx",
          },
        ],
        "kernel",
      ),
    ).toEqual([
      expect.stringContaining("No Server Action"),
      expect.stringContaining("browser storage"),
      expect.stringContaining("Client Component"),
    ]);
  });

  it("accepts a server route with a narrow interactive leaf for kernel data", () => {
    expect(
      implementationArchitectureDiagnostics(
        [
          {
            content:
              'import Form from "./form"; export default function Page() { return <Form />; }',
            path: "app/page.tsx",
          },
          { content: '"use server"; export async function save() {}', path: "app/actions.ts" },
          {
            content: '"use client"; export default function Form() { return <button />; }',
            path: "app/form.tsx",
          },
        ],
        "kernel",
      ),
    ).toEqual([]);
  });
});
