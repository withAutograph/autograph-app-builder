/* oxlint-disable unicorn/prefer-event-target -- child_process streams implement Node EventEmitter */
import { runHostedEvalWorker } from "./hosted-self-reproduction-worker-bootstrap";
/* oxlint-disable eslint/require-await -- mocked filesystem ports are asynchronous */
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  commands: [] as { cmd: string; args: string[]; env: Record<string, string> }[],
  fail: "",
  files: new Map<string, string>(),
}));
vi.mock("node:fs/promises", () => ({
  lstat: async (path: string) => ({
    isDirectory: () => path.endsWith("runtime-source"),
    isFile: () => !path.endsWith("runtime-source"),
    isSymbolicLink: () => path.endsWith("linked.json"),
  }),
  mkdir: async () => {},
  readFile: async (path: string) =>
    path === "/etc/os-release"
      ? "ID=ubuntu\n"
      : JSON.stringify({ environment: {}, toolchain: "trusted-toolchain" }),
  readdir: async () => [
    { name: "report.json" },
    { name: "eval-output.log" },
    { name: ".env.local" },
    { name: "runtime-source" },
    { name: "linked.json" },
  ],
  rename: async (from: string, to: string) => {
    state.files.set(to, state.files.get(from) ?? "");
  },
  writeFile: async (path: string, value: string) => {
    state.files.set(path, value);
  },
}));
vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: (cmd: string, args: string[], options: { env: Record<string, string> }) => {
    if (args.includes("eval:self-reproduction")) {
      expect(state.files.get("/tmp/self-reproduction-worker/worker.log")).toContain(
        "evaluation: starting",
      );
      expect(state.files.get("/tmp/self-reproduction-worker/worker.log")).not.toMatch(
        /secret-template|secret-oidc/u,
      );
    }
    state.commands.push({ args, cmd, env: { ...options.env } });
    const child = Object.assign(new EventEmitter(), {
      stderr: new EventEmitter(),
      stdout: new EventEmitter(),
    });
    queueMicrotask(() => {
      if (cmd === "pg_config") child.stdout.emit("data", "/usr/lib/postgresql/16/bin\n");
      child.stderr.emit(
        "data",
        `secret-template ${Buffer.from("x-access-token:secret-template").toString("base64")} secret-oidc`,
      );
      child.emit("close", args.includes(state.fail) ? 1 : 0);
    });
    return child;
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  state.files.clear();
  state.commands = [];
  state.fail = "";
});
it("executes fixed hosted task with process PostgreSQL and keeps clone credentials out of later commands and logs", async () => {
  vi.stubEnv("APP_BUILDER_TEMPLATE_READ_TOKEN", "secret-template");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "secret-oidc");
  await runHostedEvalWorker();
  const clone = state.commands.find(({ cmd }) => cmd === "git");
  expect(clone?.env.GIT_CONFIG_VALUE_0).toContain(
    Buffer.from("x-access-token:secret-template").toString("base64"),
  );
  const evaluation = state.commands.find(({ args }) => args.includes("eval:self-reproduction"));
  expect(evaluation?.args).toEqual(
    expect.arrayContaining([
      "--hosted-oidc",
      "--candidate-runtime",
      "--candidate-capability-probe",
      "--reference-runtime",
      "--reference-navigation",
    ]),
  );
  expect(evaluation?.args.slice(-2)).toEqual(["--postgres-backend", "process"]);
  expect(evaluation?.env.APP_BUILDER_TEMPLATE_READ_TOKEN).toBeUndefined();
  expect(evaluation?.env.GIT_CONFIG_VALUE_0).toBeUndefined();
  expect(evaluation?.env.PATH).toMatch(/^\/usr\/lib\/postgresql\/16\/bin:/u);
  expect(
    state.commands.find(({ args }) => args.includes("storybook:install-browser")),
  ).toBeDefined();
  expect(state.files.get("/tmp/self-reproduction-worker/worker.log")).not.toMatch(
    /secret-template|secret-oidc|eC1hY2Nlc3M/u,
  );
  const archive = state.commands.find(({ cmd }) => cmd === "tar");
  expect(archive?.args).toContain("report.json");
  expect(archive?.args).toContain("eval-output.log");
  expect(archive?.args).not.toContain(".env.local");
  expect(archive?.args).not.toContain("runtime-source");
  expect(archive?.args).not.toContain("linked.json");
  expect(
    JSON.parse(state.files.get("/tmp/self-reproduction-worker/result.json") ?? "{}").status,
  ).toBe("completed");
});
it("retains allowlisted partial reports and a failed receipt when evaluation exits nonzero", async () => {
  vi.stubEnv("APP_BUILDER_TEMPLATE_READ_TOKEN", "secret-template");
  vi.stubEnv("VERCEL_OIDC_TOKEN", "secret-oidc");
  state.fail = "eval:self-reproduction";
  await runHostedEvalWorker();
  const result = JSON.parse(state.files.get("/tmp/self-reproduction-worker/result.json") ?? "{}");
  expect(result.status).toBe("failed");
  expect(result.artifacts.map(({ id }: { id: string }) => id)).toContain("evidence.tar.gz");
  expect(state.files.get("/tmp/self-reproduction-worker/worker.log")).toContain(
    "evaluation: exit=1",
  );
});
