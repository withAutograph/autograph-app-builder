import { afterEach, expect, it, vi } from "vitest";

const runMaintenance = async (
  cleanup: (input: { environment: NodeJS.ProcessEnv }) => Promise<number>,
) => {
  try {
    const removed = await cleanup({ environment: process.env });
    console.log(
      JSON.stringify(
        Object.fromEntries([
          ["task", "builder-drafts-maintenance"],
          ["removed", removed],
        ]),
      ),
    );
  } catch {
    console.error("Builder draft maintenance failed.");
    process.exitCode = 1;
  }
};

const previousExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

it("invokes the existing cleanup with managed environment and its fixed 30-day default", async () => {
  const cleanup = vi.fn().mockResolvedValue(3);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await runMaintenance(cleanup);
  expect(cleanup).toHaveBeenCalledExactlyOnceWith({ environment: process.env });
  expect(log).toHaveBeenCalledExactlyOnceWith('{"task":"builder-drafts-maintenance","removed":3}');
});

it("reports failure without leaking database details", async () => {
  const cleanup = vi.fn().mockRejectedValue(new Error("postgres://user:secret@example.test/db"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await runMaintenance(cleanup);
  expect(log).toHaveBeenCalledExactlyOnceWith("Builder draft maintenance failed.");
  expect(process.exitCode).toBe(1);
});
