/* oxlint-disable sonarjs/publicly-writable-directories -- Each source fixture is an exclusive owned temporary directory, removed after its test. */
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  normalizedWorkspacePath,
  workspaceInspectionProgram,
  workspaceInspectionCommand,
} from "./workspace-path-inspection";

const roots: string[] = [];
afterEach(async () => {
  // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});
const fixture = async () => {
  const parent = await realpath(await mkdtemp(path.join(tmpdir(), "workspace-inspection-")));
  roots.push(parent);
  const root = path.join(parent, "repository");
  const directory = path.join(root, "packages/playwright-config");
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "package.json"),
    JSON.stringify({
      exports: {
        "./normal-actor-login": {
          types: "./normal-actor-login.d.ts",
          default: "./normal-actor-login.js",
        },
      },
    }),
  );
  await writeFile(path.join(directory, "normal-actor-login.js"), "export const helper = true;");
  await writeFile(
    path.join(directory, "normal-actor-login.d.ts"),
    "export declare const helper: boolean;",
  );
  return { parent, root };
};
const resultSchema = z.object({
  kind: z.string(),
  path: z.string().optional(),
  entryKind: z.string().optional(),
  entries: z.array(z.object({ path: z.string(), kind: z.string() })).optional(),
  continuation: z.object({ directoryOffset: z.number() }).optional(),
});
const inspect = (root: string, relativePath: string, directoryOffset = 0, entryBytes = 100_000) => {
  const program = workspaceInspectionProgram({
    root,
    relativePath,
    requestedPath: `/workspace/repository/${relativePath}`,
    directoryOffset,
    entryBytes,
  });
  return resultSchema.parse(
    JSON.parse(
      execFileSync(process.execPath, ["-e", program], {
        encoding: "utf-8",
        env: { NODE_ENV: "test", PATH: process.env.PATH },
      }),
    ),
  );
};
describe("actual selected workspace entry program", () => {
  it("lists both formerly failing subdirectories and their real package export file names", async () => {
    const f = await fixture();
    expect(inspect(f.root, "packages")).toMatchObject({
      entries: [{ kind: "directory", path: "/workspace/repository/packages/playwright-config" }],
      kind: "workspace-directory",
    });
    const nested = inspect(f.root, "packages/playwright-config");
    expect(nested.kind).toBe("workspace-directory");
    expect(nested.entries?.map((entry) => entry.path).toSorted()).toEqual(
      ["normal-actor-login.d.ts", "normal-actor-login.js", "package.json"]
        .map((name) => `/workspace/repository/packages/playwright-config/${name}`)
        .toSorted(),
    );
    expect(JSON.stringify(nested)).not.toContain("export const");
  });
  it("reports a missing guessed path and recognizes an actual file without executing it", async () => {
    const f = await fixture();
    expect(inspect(f.root, "packages/playwright-config/normal-actor-login.ts")).toMatchObject({
      kind: "workspace-missing",
    });
    expect(inspect(f.root, "packages/playwright-config/normal-actor-login.js")).toMatchObject({
      entryKind: "file",
      kind: "workspace-entry",
    });
  });
  it("rejects traversal and a directory symlink outside its selected source", async () => {
    const f = await fixture();
    await mkdir(path.join(f.parent, "private"));
    await writeFile(path.join(f.parent, "private/secret"), "not source");
    await symlink(path.join(f.parent, "private"), path.join(f.root, "escape"));
    expect(inspect(f.root, "../private").kind).toBe("workspace-path-denied");
    expect(inspect(f.root, "escape").kind).toBe("workspace-path-denied");
    expect(() => normalizedWorkspacePath("/workspace/repository/../private")).toThrow(
      "stay inside",
    );
  });
  it("denies a selected root replaced by a symlink to a different source", async () => {
    const f = await fixture();
    const alias = path.join(f.parent, "aliased-root");
    await symlink(f.root, alias);
    expect(inspect(alias, "packages").kind).toBe("workspace-path-denied");
  });
  it("pages all actual immediate entries without a total count cap or following child symlinks", async () => {
    const f = await fixture();
    const directory = path.join(f.root, "many");
    await mkdir(directory);
    await Promise.all(
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
      Array.from({ length: 80 }, (_, index) =>
        writeFile(path.join(directory, `entry-${index}.js`), "fixture"),
      ),
    );
    await symlink(path.join(f.parent, "missing"), path.join(directory, "link"));
    const rows = [];
    let offset: number | undefined = 0;
    let pages = 0;
    while (offset !== undefined) {
      const page = inspect(f.root, "many", offset, 240);
      rows.push(...(page.entries ?? []));
      pages += 1;
      const previous = offset;
      offset = page.continuation?.directoryOffset;
      if (offset !== undefined) {
        expect(offset).toBeGreaterThan(previous);
      }
    }
    expect(pages).toBeGreaterThan(1);
    expect(rows).toHaveLength(81);
    expect(new Set(rows.map((row) => row.path)).size).toBe(81);
    expect(rows.find((row) => row.path.endsWith("/link"))?.kind).toBe("symlink");
  });
  it("executes its exact shell command without interpreting quoted workspace names", async () => {
    const f = await fixture();
    const relativePath = "packages/quoted'$(false)";
    await mkdir(path.join(f.root, relativePath));
    await writeFile(path.join(f.root, relativePath, "actual.js"), "source");
    const command = workspaceInspectionCommand({
      root: f.root,
      relativePath,
      requestedPath: `/workspace/repository/${relativePath}`,
      directoryOffset: 0,
      entryBytes: 100_000,
    });
    const output = execFileSync("/bin/sh", ["-c", command], {
      encoding: "utf-8",
      env: {
        NODE_ENV: "test",
        NODE_OPTIONS: "",
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
      },
    });
    expect(resultSchema.parse(JSON.parse(output))).toMatchObject({
      entries: [{ kind: "file", path: `/workspace/repository/${relativePath}/actual.js` }],
      kind: "workspace-directory",
    });
  });
});
