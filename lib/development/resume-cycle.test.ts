import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { expect, it } from "vitest";
import { z } from "zod";
import { createDevelopmentCycle } from "./application-root";
import { resumeDevelopmentCycle } from "./resume-cycle";
import { parseDevelopmentArguments } from "./local-mode";

const fixture = async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "builder-explicit-resume-")));
  const repositoryRoot = path.join(root, "repository");
  const runsRoot = path.join(root, "runs");
  await mkdir(repositoryRoot, { mode: 0o700 });
  await mkdir(runsRoot, { mode: 0o700 });
  await mkdir(path.join(repositoryRoot, "node_modules"), { mode: 0o700 });
  await writeFile(path.join(repositoryRoot, "agent.ts"), "export const revision=1;\n");
  await writeFile(path.join(repositoryRoot, ".gitignore"), "node_modules\n.eve\n");
  execFileSync("/usr/bin/git", ["init", "--quiet", repositoryRoot]);
  execFileSync("/usr/bin/git", ["-C", repositoryRoot, "add", "."]);
  const supervisorRoot = await mkdtemp(path.join(runsRoot, "supervisor-"));
  const cycle = await createDevelopmentCycle({ repositoryRoot, supervisorRoot });
  await mkdir(path.join(cycle.application.root, ".eve/.workflow-data"), {
    recursive: true,
    mode: 0o700,
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
  return { root, repositoryRoot, runsRoot, cycle, server, port: address.port };
};
it("resumes one stopped local cycle with current code and unchanged saved state, under the caller’s state-root lock", async () => {
  const f = await fixture();
  try {
    const closed = once(f.server, "close");
    f.server.close();
    await closed;
    await rm(path.join(f.cycle.application.root, ".eve/dev-server-state.v1.json"));
    await writeFile(path.join(f.repositoryRoot, "agent.ts"), "export const revision=2;\n");
    const resumed = await resumeDevelopmentCycle({
      repositoryRoot: f.repositoryRoot,
      runsRoot: f.runsRoot,
      cycleRoot: f.cycle.root,
      evePort: f.port,
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
    await rm(f.root, { recursive: true, force: true });
  }
});
it("refuses a running instance and a different state root without modifying its source or saved sessions", async () => {
  const f = await fixture();
  try {
    await expect(
      resumeDevelopmentCycle({
        repositoryRoot: f.repositoryRoot,
        runsRoot: f.runsRoot,
        cycleRoot: f.cycle.root,
        evePort: f.port,
      }),
    ).rejects.toThrow("Stop this local Builder instance");
    const foreign = path.join(f.root, "another-runs");
    await mkdir(foreign, { mode: 0o700 });
    await expect(
      resumeDevelopmentCycle({
        repositoryRoot: f.repositoryRoot,
        runsRoot: foreign,
        cycleRoot: f.cycle.root,
        evePort: f.port,
      }),
    ).rejects.toThrow("cannot be resumed safely");
    expect(await readFile(path.join(f.cycle.application.root, "agent.ts"), "utf-8")).toContain(
      "revision=1",
    );
  } finally {
    const closed = once(f.server, "close");
    f.server.close();
    await closed;
    await rm(f.root, { recursive: true, force: true });
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
