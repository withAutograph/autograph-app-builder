import { afterEach, expect, it, vi } from "vitest";

const maintenance = vi.hoisted(() => ({ cleanup: vi.fn() }));
vi.mock("../lib/builder-drafts/deployment", () => ({
  deleteInactiveBuilderDraftsForMaintenance: maintenance.cleanup,
}));

const previousExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
  maintenance.cleanup.mockReset();
  vi.resetModules();
});

it("invokes the existing cleanup with managed environment and its fixed 30-day default", async () => {
  maintenance.cleanup.mockResolvedValue(3);
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  await import("./maintenance-builder-drafts.mts");
  expect(maintenance.cleanup).toHaveBeenCalledExactlyOnceWith({ environment: process.env });
  expect(log).toHaveBeenCalledExactlyOnceWith('{"task":"builder-drafts-maintenance","removed":3}');
});

it("reports failure without leaking database details", async () => {
  maintenance.cleanup.mockRejectedValue(new Error("postgres://user:secret@example.test/db"));
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  await import("./maintenance-builder-drafts.mts");
  expect(log).toHaveBeenCalledExactlyOnceWith("Builder draft maintenance failed.");
  expect(process.exitCode).toBe(1);
});
