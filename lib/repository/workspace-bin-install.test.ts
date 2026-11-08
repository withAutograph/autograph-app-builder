import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { workspaceBinInstallCommand } from "./workspace-bin-install";

it.each([
  { bytes: "original", change: "chmod 777 packages/owned/cli.js", exit: 0, mode: 0o755 },
  { bytes: "original", change: "chmod 777 packages/owned/cli.js; exit 12", exit: 12, mode: 0o755 },
  {
    bytes: "changed",
    change: "chmod 777 packages/owned/cli.js; printf changed > packages/owned/cli.js",
    exit: 1,
    mode: 0o777,
  },
  {
    bytes: "original",
    change:
      "mv packages/owned/cli.js packages/owned/old.js; cp -p packages/owned/old.js packages/owned/cli.js; chmod 777 packages/owned/cli.js",
    exit: 1,
    mode: 0o777,
  },
  { bytes: "original", change: "chmod 775 packages/owned/cli.js", exit: 0, mode: 0o775 },
  {
    bytes: "original",
    change: "chmod 777 packages/owned/cli.js",
    exit: 0,
    mode: 0o644,
    originalMode: 0o644,
  },
])(
  "preserves the owned bin preimage only on known mode drift ($change)",
  ({ change, exit, mode, bytes, originalMode }) => {
    const root = mkdtempSync(path.join(realpathSync(tmpdir()), "workspace-bin-install-"));
    try {
      const owned = path.join(root, "packages/owned");
      const undeclared = path.join(root, "packages/other");
      mkdirSync(owned, { recursive: true });
      mkdirSync(undeclared);
      writeFileSync(
        path.join(root, "package.json"),
        JSON.stringify({ workspaces: ["packages/owned"] }),
      );
      for (const directory of [owned, undeclared]) {
        writeFileSync(path.join(directory, "package.json"), JSON.stringify({ bin: "./cli.js" }));
        const target = path.join(directory, "cli.js");
        writeFileSync(target, "original");
        chmodSync(target, originalMode ?? 0o755);
      }
      writeFileSync(
        path.join(root, "bun"),
        `#!/bin/sh\n[ "$1:$2" = "install:--frozen-lockfile" ] || exit 99\nchmod 777 packages/other/cli.js\n${change}\n`,
        { mode: 0o700 },
      );
      const result = spawnSync("/bin/sh", ["-c", workspaceBinInstallCommand(root, true)], {
        cwd: root,
        env: {
          NODE_ENV: "test",
          PATH: [root, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
        },
      });
      expect(result.status).toBe(exit);
      const target = path.join(owned, "cli.js");
      expect(statSync(target).mode % 4096).toBe(mode);
      expect(readFileSync(target, "utf-8")).toBe(bytes);
      expect(statSync(path.join(undeclared, "cli.js")).mode % 4096).toBe(0o777);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  },
);

it("refuses a workspace bin symlink before Bun can chmod its target", () => {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "workspace-bin-install-"));
  try {
    const directory = path.join(root, "owned");
    const sentinel = path.join(root, "sentinel");
    mkdirSync(directory);
    writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["owned"] }));
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ bin: "./cli.js" }));
    writeFileSync(sentinel, "sentinel", { mode: 0o755 });
    symlinkSync(sentinel, path.join(directory, "cli.js"));
    writeFileSync(path.join(root, "bun"), "#!/bin/sh\nchmod 777 sentinel\n", { mode: 0o700 });
    const result = spawnSync("/bin/sh", ["-c", workspaceBinInstallCommand(root, false)], {
      cwd: root,
      env: {
        NODE_ENV: "test",
        PATH: [root, path.dirname(process.execPath), "/usr/bin", "/bin"].join(path.delimiter),
      },
    });
    expect(result.status).toBe(1);
    expect(statSync(sentinel).mode % 4096).toBe(0o755);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
