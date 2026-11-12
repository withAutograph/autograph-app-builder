import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  writeFile,
  readFile,
  realpath,
  rm,
  symlink,
  stat,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, Socket } from "node:net";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createDevelopmentCycle } from "./application-root";
import { resumeDevelopmentCycle } from "./resume-cycle";
import { parseDevelopmentArguments } from "./local-mode";

const installFixtureDependencies = async (repositoryRoot: string, revision: string) => {
  await mkdir(path.join(repositoryRoot, "node_modules/.pnpm"), { mode: 0o700, recursive: true });
  await mkdir(path.join(repositoryRoot, "node_modules/eve"), { mode: 0o700, recursive: true });
  const lock = `lockfileVersion: '9.0'\nrevision: ${revision}\n`;
  await writeFile(path.join(repositoryRoot, "pnpm-lock.yaml"), lock);
  await writeFile(path.join(repositoryRoot, "node_modules/.pnpm/lock.yaml"), lock);
  await writeFile(
    path.join(repositoryRoot, "node_modules/eve/package.json"),
    JSON.stringify({
      name: "eve",
      main: "index.cjs",
      exports: { ".": "./index.cjs", "./package.json": "./package.json" },
    }),
  );
  await writeFile(
    path.join(repositoryRoot, "node_modules/eve/index.cjs"),
    `module.exports={revision:${JSON.stringify(revision)}};`,
  );
};
const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "builder-explicit-resume-")));
  const repositoryRoot = path.join(root, "repository");
  const runsRoot = path.join(root, "runs");
  await mkdir(repositoryRoot, { mode: 0o700 });
  await mkdir(runsRoot, { mode: 0o700 });
  await mkdir(path.join(repositoryRoot, "node_modules"), { mode: 0o700 });
  await installFixtureDependencies(repositoryRoot, "original");
  await writeFile(path.join(repositoryRoot, "agent.ts"), "export const revision=1;\n");
  await writeFile(path.join(repositoryRoot, ".gitignore"), "node_modules\n.eve\n");
  execFileSync("/usr/bin/git", ["init", "--quiet", repositoryRoot]);
  execFileSync("/usr/bin/git", ["-C", repositoryRoot, "add", "."]);
  const supervisorRoot = await mkdtemp(path.join(runsRoot, "supervisor-"));
  const cycle = await createDevelopmentCycle({ repositoryRoot, supervisorRoot });
  await mkdir(path.join(cycle.application.root, ".eve/.workflow-data"), {
    mode: 0o700,
    recursive: true,
  });
  await writeFile(
    path.join(cycle.application.root, ".eve/.workflow-data/session.json"),
    ' {"session":"original","state":"waiting"}\n',
  );
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = z.object({ port: z.number().int() }).parse(server.address());
  await writeFile(
    path.join(cycle.application.root, ".eve/dev-server-state.v1.json"),
    JSON.stringify({ url: `http://127.0.0.1:${address.port}` }),
  );
  return { cycle, port: address.port, repositoryRoot, root, runsRoot, server };
};
it("resumes one stopped local cycle with current code and unchanged saved state, under the caller’s state-root lock", async () => {
  const f = await fixture();
  // Control the stopped precondition while testing saved state: a parallel fixture
  // can claim a released port. The running-instance test below retains real TCP.
  const stoppedConnection = vi
    .spyOn(Socket.prototype, "connect")
    .mockImplementation(function connectStoppedFixture(this: Socket) {
      queueMicrotask(() => {
        this.destroy(Object.assign(new Error("Stopped fixture"), { code: "ECONNREFUSED" }));
      });
      return this;
    });
  try {
    const closed = once(f.server, "close");
    f.server.close();
    await closed;
    await rm(path.join(f.cycle.application.root, ".eve/dev-server-state.v1.json"));
    await writeFile(path.join(f.repositoryRoot, "agent.ts"), "export const revision=2;\n");
    const resumed = await resumeDevelopmentCycle({
      cycleRoot: f.cycle.root,
      evePort: f.port,
      repositoryRoot: f.repositoryRoot,
      runsRoot: f.runsRoot,
    });
    expect(resumed.application.root).toBe(f.cycle.application.root);
    expect(await readFile(path.join(resumed.application.root, "agent.ts"), "utf-8")).toContain(
      "revision=2",
    );
    expect(
      await readFile(
        path.join(resumed.application.root, ".eve/.workflow-data/session.json"),
        "utf-8",
      ),
    ).toBe(' {"session":"original","state":"waiting"}\n');
  } finally {
    stoppedConnection.mockRestore();
    await rm(f.root, { force: true, recursive: true });
  }
});
it("refuses a running instance and a different state root without modifying its source or saved sessions", async () => {
  const f = await fixture();
  try {
    await expect(
      resumeDevelopmentCycle({
        cycleRoot: f.cycle.root,
        evePort: f.port,
        repositoryRoot: f.repositoryRoot,
        runsRoot: f.runsRoot,
      }),
    ).rejects.toThrow("Stop this local Builder instance");
    const foreign = path.join(f.root, "another-runs");
    await mkdir(foreign, { mode: 0o700 });
    await expect(
      resumeDevelopmentCycle({
        cycleRoot: f.cycle.root,
        evePort: f.port,
        repositoryRoot: f.repositoryRoot,
        runsRoot: foreign,
      }),
    ).rejects.toThrow("cannot be resumed safely");
    expect(await readFile(path.join(f.cycle.application.root, "agent.ts"), "utf-8")).toContain(
      "revision=1",
    );
  } finally {
    const closed = once(f.server, "close");
    f.server.close();
    await closed;
    await rm(f.root, { force: true, recursive: true });
  }
});
it("requires explicit local recovery paths instead of selecting another instance automatically", () => {
  expect(() =>
    parseDevelopmentArguments(["--arrusted-root", "/source", "--resume-cycle", "/cycle"]),
  ).toThrow("explicit --state-root");
  expect(
    parseDevelopmentArguments([
      "--arrusted-root",
      "/source",
      "--state-root",
      "/state",
      "--resume-cycle",
      "/state/runs/supervisor-one/cycle-one",
    ]).resumeCycle,
  ).toBe("/state/runs/supervisor-one/cycle-one");
});

it("resumes the same real cycle from a second checkout and loads that checkout's installed runtime while retaining native state", async () => {
  const f = await fixture();
  try {
    const closed = once(f.server, "close");
    f.server.close();
    await closed;
    await installFixtureDependencies(f.repositoryRoot, "old-runtime");
    const second = path.join(f.root, "second-checkout");
    await mkdir(second, { mode: 0o700 });
    await writeFile(path.join(second, ".gitignore"), "node_modules\n.eve\n");
    await writeFile(path.join(second, "agent.ts"), "export const revision=2;\n");
    await installFixtureDependencies(second, "selected-runtime");
    execFileSync("/usr/bin/git", ["init", "--quiet", second]);
    execFileSync("/usr/bin/git", ["-C", second, "add", "."]);
    const stateFile = path.join(f.cycle.application.root, ".eve/.workflow-data/session.json");
    const state = await readFile(stateFile);
    const before = await stat(stateFile);
    const load = () =>
      execFileSync(process.execPath, ["-e", 'process.stdout.write(require("eve").revision)'], {
        cwd: f.cycle.application.root,
        encoding: "utf-8",
      });
    expect(load()).toBe("old-runtime");
    const resumed = await resumeDevelopmentCycle({
      cycleRoot: f.cycle.root,
      evePort: f.port,
      repositoryRoot: second,
      runsRoot: f.runsRoot,
    });
    expect(load()).toBe("selected-runtime");
    expect(await realpath(path.join(resumed.application.root, "node_modules"))).toBe(
      path.join(second, "node_modules"),
    );
    expect(resumed.dependencyBinding.sourceLockSha256).toBe(
      resumed.dependencyBinding.installedLockSha256,
    );
    expect(resumed.dependencyBinding.evePackagePath).toBe(
      path.join(second, "node_modules/eve/package.json"),
    );
    expect(await readFile(stateFile)).toEqual(state);
    const after = await stat(stateFile);
    expect(after.ino).toBe(before.ino);
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
});
it("reports an actionable stale selected install before replacing source, dependencies or native state", async () => {
  const f = await fixture();
  try {
    const closed = once(f.server, "close");
    f.server.close();
    await closed;
    await installFixtureDependencies(f.repositoryRoot, "installed");
    await writeFile(
      path.join(f.repositoryRoot, "pnpm-lock.yaml"),
      "new selected dependency lock\n",
    );
    const original = await realpath(path.join(f.cycle.application.root, "node_modules"));
    await expect(
      resumeDevelopmentCycle({
        cycleRoot: f.cycle.root,
        evePort: f.port,
        repositoryRoot: f.repositoryRoot,
        runsRoot: f.runsRoot,
      }),
    ).rejects.toThrow("pnpm install --frozen-lockfile");
    expect(await realpath(path.join(f.cycle.application.root, "node_modules"))).toBe(original);
    expect(
      await readFile(
        path.join(f.cycle.application.root, ".eve/.workflow-data/session.json"),
        "utf-8",
      ),
    ).toContain('"session":"original"');
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
});
it("preserves an intentionally selected owner-bound dependency cache while rebinding the cycle", async () => {
  const f = await fixture();
  // A parallel test can claim the port after this fixture releases it. The
  // running-instance test retains a real connection check.
  const stoppedConnection = vi
    .spyOn(Socket.prototype, "connect")
    .mockImplementation(function connectStoppedFixture(this: Socket) {
      queueMicrotask(() => {
        this.destroy(Object.assign(new Error("Stopped fixture"), { code: "ECONNREFUSED" }));
      });
      return this;
    });
  try {
    const closed = once(f.server, "close");
    f.server.close();
    await closed;
    const cache = path.join(f.root, "selected-owner-cache");
    await rename(path.join(f.repositoryRoot, "node_modules"), cache);
    await symlink(cache, path.join(f.repositoryRoot, "node_modules"));
    const resumed = await resumeDevelopmentCycle({
      cycleRoot: f.cycle.root,
      evePort: f.port,
      repositoryRoot: f.repositoryRoot,
      runsRoot: f.runsRoot,
    });
    expect(resumed.dependencyBinding.modulesRoot).toBe(cache);
    expect(await realpath(path.join(resumed.application.root, "node_modules"))).toBe(cache);
  } finally {
    stoppedConnection.mockRestore();
    await rm(f.root, { force: true, recursive: true });
  }
});
it("rejects stale per-package Eve resolution outside the selected installed tree before modifying the cycle", async () => {
  const f = await fixture();
  try {
    const closed = once(f.server, "close");
    f.server.close();
    await closed;
    const external = path.join(f.root, "stale-eve");
    await rename(path.join(f.repositoryRoot, "node_modules/eve"), external);
    await symlink(external, path.join(f.repositoryRoot, "node_modules/eve"));
    await expect(
      resumeDevelopmentCycle({
        cycleRoot: f.cycle.root,
        evePort: f.port,
        repositoryRoot: f.repositoryRoot,
        runsRoot: f.runsRoot,
      }),
    ).rejects.toThrow("outside its selected dependency tree");
    expect(
      await readFile(
        path.join(f.cycle.application.root, ".eve/.workflow-data/session.json"),
        "utf-8",
      ),
    ).toContain('"session":"original"');
  } finally {
    await rm(f.root, { force: true, recursive: true });
  }
});

it("rejects a non-link retained dependency directory before replacing authored or native files", async () => {
  const f = await fixture();
  // Another parallel fixture can reuse this released ephemeral port. Own the stopped
  // precondition here; the running/stopped TCP controls above retain real sockets.
  const stoppedConnection = vi
    .spyOn(Socket.prototype, "connect")
    .mockImplementation(function connectStoppedFixture(this: Socket) {
      queueMicrotask(() => {
        this.destroy(Object.assign(new Error("Stopped fixture"), { code: "ECONNREFUSED" }));
      });
      return this;
    });
  try {
    const closed = once(f.server, "close");
    f.server.close();
    await closed;
    const modules = path.join(f.cycle.application.root, "node_modules");
    await rm(modules);
    await mkdir(modules, { mode: 0o700 });
    await writeFile(path.join(modules, "retained.txt"), "preserve this owned directory");
    const stateFile = path.join(f.cycle.application.root, ".eve/.workflow-data/session.json");
    const before = await stat(stateFile);
    const state = await readFile(stateFile);
    await writeFile(path.join(f.repositoryRoot, "agent.ts"), "export const revision=2;\n");
    await expect(
      resumeDevelopmentCycle({
        cycleRoot: f.cycle.root,
        evePort: f.port,
        repositoryRoot: f.repositoryRoot,
        runsRoot: f.runsRoot,
      }),
    ).rejects.toThrow("not its owned dependency link");
    expect(await readFile(path.join(f.cycle.application.root, "agent.ts"), "utf-8")).toContain(
      "revision=1",
    );
    expect(await readFile(path.join(modules, "retained.txt"), "utf-8")).toBe(
      "preserve this owned directory",
    );
    expect(await readFile(stateFile)).toEqual(state);
    const after = await stat(stateFile);
    expect(after.ino).toBe(before.ino);
  } finally {
    stoppedConnection.mockRestore();
    await rm(f.root, { force: true, recursive: true });
  }
});
