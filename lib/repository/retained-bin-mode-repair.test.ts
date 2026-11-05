import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  retainedBinModeObservation,
  retainedBinModeRepairCommand,
} from "./retained-bin-mode-repair";
import { OVERLAY_SNAPSHOT_INVENTORY_SCRIPT } from "./target-apply";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const fixture = () => {
  const directory = realpathSync(mkdtempSync(path.join(tmpdir(), "retained-bin-repair-")));
  temporary.push(directory);
  const root = path.join(directory, "repository");
  mkdirSync(root);
  mkdirSync(path.join(directory, ".app-builder"));
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  const files = ["alpha", "beta"].map((name) => {
    const folder = path.join(root, "packages", name);
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, "package.json"), JSON.stringify({ name, bin: "./cli.js" }));
    const file = path.join(folder, "cli.js");
    writeFileSync(file, name, { mode: 0o755 });
    chmodSync(file, 0o755);
    return file;
  });
  const snapshot = spawnSync(
    process.execPath,
    [
      "-e",
      `const expectedOverlayRoot = process.cwd(); ${OVERLAY_SNAPSHOT_INVENTORY_SCRIPT}; console.log(JSON.stringify(files.map(({digest,mode,path}) => ({digest,mode,path}))));`,
    ],
    { cwd: root, encoding: "utf-8" },
  );
  expect(snapshot.status).toBe(0);
  const expectedDigest = createHash("sha256").update(snapshot.stdout.trim()).digest("hex");
  for (const file of files) {
    chmodSync(file, 0o777);
  }
  const run = (approved?: ReturnType<typeof retainedBinModeObservation.parse>, preload?: string) =>
    spawnSync("/bin/sh", ["-c", retainedBinModeRepairCommand({ root, expectedDigest, approved })], {
      cwd: root,
      encoding: "utf-8",
      env: {
        NODE_ENV: "test",
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        ...(preload === undefined ? {} : { NODE_OPTIONS: `--require=${preload}` }),
      },
    });
  const inspect = () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    return retainedBinModeObservation.parse(JSON.parse(result.stdout));
  };
  const modes = () => files.map((file) => statSync(file).mode % 4096);
  const marker = path.join(directory, ".app-builder", `retained-bin-mode-repair-${expectedDigest}`);
  return { files, root, inspect, run, modes, marker };
};

describe("retained workspace bin mode repair", () => {
  it("restores the exact overlay without changing bytes and reserves the artifact across processes", () => {
    const checkout = fixture();
    const approved = checkout.inspect();
    expect(checkout.modes()).toEqual([0o777, 0o777]);
    expect(existsSync(checkout.marker)).toBe(false);
    const result = checkout.run(approved);
    expect(result.status, result.stderr).toBe(0);
    expect(checkout.modes()).toEqual([0o755, 0o755]);
    expect(checkout.files.map((file) => readFileSync(file, "utf-8"))).toEqual(["alpha", "beta"]);
    expect(statSync(checkout.marker).mode % 4096).toBe(0o600);
    expect(JSON.parse(checkout.run().stdout)).toEqual({ status: "restored" });
    for (const file of checkout.files) {
      chmodSync(file, 0o777);
    }
    expect(checkout.run(approved).status).toBe(1);
    expect(JSON.parse(checkout.run().stdout)).toEqual({ status: "reconciliation-required" });
    expect(checkout.modes()).toEqual([0o777, 0o777]);
  });

  it("records a partial write as reconciliation-required across independent processes", () => {
    const checkout = fixture();
    const approved = checkout.inspect();
    const preload = path.join(path.dirname(checkout.root), "fail-second-chmod.cjs");
    writeFileSync(
      preload,
      `
      const fs = require("node:fs");
      const chmod = fs.fchmodSync;
      let writes = 0;
      fs.fchmodSync = (fd, mode) => {
        if (mode === 0o755 && ++writes === 2) throw new Error("injected second chmod failure");
        return chmod(fd, mode);
      };
    `,
    );
    expect(checkout.run(approved, preload).status).toBe(1);
    expect(checkout.modes()).toEqual([0o755, 0o777]);
    expect(JSON.parse(checkout.run().stdout)).toEqual({ status: "reconciliation-required" });
    expect(checkout.run(approved).status).toBe(1);
    expect(checkout.modes()).toEqual([0o755, 0o777]);
  });

  it("leaves a later bin untouched when its bytes change in place during the repair", () => {
    const checkout = fixture();
    const approved = checkout.inspect();
    const preload = path.join(path.dirname(checkout.root), "change-second-target.cjs");
    writeFileSync(
      preload,
      `
      const fs = require("node:fs");
      const chmod = fs.fchmodSync;
      fs.fchmodSync = (fd, mode) => {
        if (mode === 0o755) fs.writeFileSync(${JSON.stringify(checkout.files[1])}, "changed");
        return chmod(fd, mode);
      };
    `,
    );
    expect(checkout.run(approved, preload).status).toBe(1);
    expect(checkout.modes()).toEqual([0o755, 0o777]);
    expect(JSON.parse(checkout.run().stdout)).toEqual({ status: "reconciliation-required" });
  });

  it("refuses the entire pair when a later target changes inode with identical bytes and mode", () => {
    const checkout = fixture();
    const approved = checkout.inspect();
    const file = checkout.files[1];
    const replacement = path.join(path.dirname(file), "replacement");
    writeFileSync(replacement, "beta");
    chmodSync(replacement, 0o777);
    renameSync(replacement, file);
    expect(checkout.run(approved).status).toBe(1);
    expect(checkout.modes()).toEqual([0o777, 0o777]);
    expect(existsSync(checkout.marker)).toBe(false);
  });

  it("refuses unrelated checkout changes and source symlinks", () => {
    const checkout = fixture();
    const approved = checkout.inspect();
    const unrelated = path.join(checkout.root, "unrelated");
    writeFileSync(unrelated, "new");
    expect(checkout.run(approved).status).toBe(1);
    expect(checkout.modes()).toEqual([0o777, 0o777]);
    rmSync(unrelated);
    const file = checkout.files[1];
    rmSync(file);
    symlinkSync(checkout.files[0], file);
    expect(checkout.run(approved).status).toBe(1);
    expect(checkout.modes()).toEqual([0o777, 0o777]);
    expect(existsSync(checkout.marker)).toBe(false);
  });
});
