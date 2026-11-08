/* oxlint-disable eslint/require-await -- Synthetic ports retain the asynchronous failure boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  observeRepositoryProductionPhase,
  reportRepositoryProductionFailure,
} from "./repository-production-diagnostic";

afterEach(() => vi.restoreAllMocks());

describe("private Production failure diagnostics", () => {
  it("retains only fixed labels, an allowlisted SQLSTATE and numeric HTTP status", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const secret = "postgresql://private-user:private-password@private-host/database";
    const failure = Object.assign(new Error(secret, { cause: { token: secret } }), {
      code: "28P01",
      statusCode: 403,
      response: { body: secret },
      token: secret,
    });
    reportRepositoryProductionFailure("maintenance_identity", "provider_unavailable", failure);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"phase":"maintenance_identity"'));
    const output = log.mock.calls.flat().join("");
    expect(output).toContain('"sqlState":"28P01"');
    expect(output).toContain('"httpStatus":403');
    expect(output).not.toContain(secret);
    expect(output).not.toContain("private-password");
    expect(output).not.toContain("response");
    expect(output).not.toContain("cause");
  });

  it("does not read accessors or include unknown codes and invalid status values", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const access = vi.fn(() => {
      throw new Error("private accessor");
    });
    const failure = Object.defineProperties(
      {},
      {
        code: { get: access },
        statusCode: { get: access },
        status: { value: "403" },
        message: { get: access },
        cause: { get: access },
        name: { get: access },
        _zod: { get: access },
      },
    );
    reportRepositoryProductionFailure("workload_oidc_verify", "workload_unavailable", failure);
    reportRepositoryProductionFailure("sandbox_create", "provider_unavailable", {
      code: "private-provider-code",
      statusCode: 999,
    });
    expect(access).not.toHaveBeenCalled();
    const output = log.mock.calls.flat().join("");
    expect(output).not.toContain("private");
    expect(output).not.toContain("httpStatus");
    expect(output).not.toContain("sqlState");
  });

  it.each([
    ["repository_production_approval_required", "approval_required"],
    ["repository_production_owner_changed", "authority_changed"],
    ["repository_production_journal_scope_mismatch", "journal_scope_mismatch"],
    ["repository_production_conflict", "journal_conflict"],
    ["repository_production_lease_unavailable", "lease_unavailable"],
    ["Protected resource lease session was lost.", "lease_session_unavailable"],
    ["Protected resource lease session was lost or replaced.", "lease_session_unavailable"],
    ["Protected resource lease lock was lost.", "lease_lock_lost"],
    ["Protected resource lease fence is stale.", "lease_fence_stale"],
    ["repository_production_destination_changed", "destination_changed"],
    ["repository_production_reconciliation_required", "reconciliation_required"],
  ])("classifies fixed failure %s without serializing exception data", (message, reason) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new Error(message, { cause: "private-cause-token" });
    failure.stack = "private-stack-url";
    reportRepositoryProductionFailure("setup_prepare", "setup_unavailable", failure);
    expect(log).toHaveBeenCalledWith(
      JSON.stringify({
        event: "builder.repository_production_failure",
        phase: "setup_prepare",
        code: "setup_unavailable",
        reason,
      }),
    );
    const output = log.mock.calls.flat().join("");
    expect(output).not.toContain(message);
    expect(output).not.toContain("private");
  });

  it("recognizes actual Zod validation failures without exposing their issues", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const invalid = z.literal("approved").safeParse("private-schema-value");
    expect(invalid.success).toBe(false);
    reportRepositoryProductionFailure("setup_projection", "setup_unavailable", invalid.error);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"reason":"schema_invalid"'));
    expect(log.mock.calls.flat().join("")).not.toContain("private-schema-value");
  });

  it("does not infer a reason from partial text, inherited values or nested causes", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const known = "repository_production_owner_changed";
    for (const failure of [
      new Error(`${known}: private-token`),
      Object.create({ message: known }),
      new Error("private-token", { cause: new Error(known) }),
    ]) {
      reportRepositoryProductionFailure("setup_prepare", "setup_unavailable", failure);
    }
    const output = log.mock.calls.flat().join("");
    expect(output).not.toContain("reason");
    expect(output).not.toContain(known);
    expect(output).not.toContain("private-token");
  });

  it("preserves the exact original rejection when diagnostic access or logging fails", async () => {
    const privateFailure = new Proxy(new Error("private rejection"), {
      getOwnPropertyDescriptor() {
        throw new Error("private descriptor");
      },
    });
    const run = vi.fn(async () => {
      throw privateFailure;
    });
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logger down");
    });
    await expect(
      observeRepositoryProductionPhase("sandbox_create", "provider_unavailable", run),
    ).rejects.toBe(privateFailure);
    expect(run).toHaveBeenCalledTimes(1);
    const original = new Error("private failure");
    await expect(
      observeRepositoryProductionPhase(
        "workload_oidc_acquire",
        "workload_unavailable",
        async () => {
          throw original;
        },
      ),
    ).rejects.toBe(original);
  });

  it("returns successful work unchanged without producing a failure record", async () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = { status: "unchanged" };
    await expect(
      observeRepositoryProductionPhase(
        "sandbox_create",
        "provider_unavailable",
        async () => result,
      ),
    ).resolves.toBe(result);
    expect(log).not.toHaveBeenCalled();
  });
});
