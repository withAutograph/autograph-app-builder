/* oxlint-disable eslint/require-await -- Synthetic ports retain the asynchronous failure boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HostedOperatorError } from "./hosted-operator-contract";
import {
  observeRepositoryProductionPhase,
  reportRepositoryProductionFailure,
  reportRepositoryProductionProgress,
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
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      event: "builder.repository_production_failure",
      phase: "setup_prepare",
      code: "setup_unavailable",
      reason,
      errorKind: "Error",
    });
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

  it("retains a real typed operator code without exposing its private cause", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failure = new HostedOperatorError("operator_unavailable", {
      cause: new Error("private-provider-key"),
    });
    reportRepositoryProductionFailure("setup_prepare", "setup_unavailable", failure);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      operatorCode: "operator_unavailable",
      errorKind: "Error",
    });
    expect(log.mock.calls.flat().join("")).not.toContain("private-provider-key");
  });

  it.each([
    [new Error("private-error"), "Error"],
    [new TypeError("private-type"), "TypeError"],
    [new RangeError("private-range"), "RangeError"],
    [new DOMException("private-cancel", "AbortError"), "DOMException"],
  ])("recognizes native error kind without reading inherited names", (failure, kind) => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportRepositoryProductionFailure("setup_prepare", "setup_unavailable", failure);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ errorKind: kind });
    expect(log.mock.calls.flat().join("")).not.toContain("private");
  });

  it("extracts only allowlisted SQLSTATEs from bounded own-data cause chains", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const driver = { code: "42501", message: "private-sql", status: 403 };
    const wrapped = new Error("private-query-and-parameters", { cause: driver });
    reportRepositoryProductionFailure("setup_prepare", "setup_unavailable", wrapped);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ sqlState: "42501" });
    const output = log.mock.calls.flat().join("");
    expect(output).not.toContain("private");
    expect(output).not.toContain("httpStatus");
    log.mockClear();
    const tooDeep = { cause: { cause: { cause: { cause: driver } } } };
    const inherited: unknown = Object.create({ cause: driver });
    const cyclic = { cause: {} };
    cyclic.cause = cyclic;
    for (const failure of [tooDeep, inherited, cyclic]) {
      reportRepositoryProductionFailure("setup_prepare", "setup_unavailable", failure);
    }
    expect(log.mock.calls.flat().join("")).not.toContain("sqlState");
  });

  it("does not invoke hostile field getters or proxy reads while collecting metadata", () => {
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const access = vi.fn(() => {
      throw new Error("private getter");
    });
    const inner = Object.defineProperties({}, { code: { get: access }, cause: { get: access } });
    const failure = new Proxy(new Error("private-wrapper", { cause: inner }), { get: access });
    reportRepositoryProductionFailure("setup_prepare", "setup_unavailable", failure);
    expect(access).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalled();
    expect(log.mock.calls.flat().join("")).not.toContain("private");
  });

  it("retains cancellation and the exact original error even when its observer fails", async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = new HostedOperatorError("operator_unavailable");
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = async () => {
      throw failure;
    };
    await expect(
      observeRepositoryProductionPhase(
        "setup_prepare",
        "setup_unavailable",
        run,
        controller.signal,
      ),
    ).rejects.toBe(failure);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({ requestAborted: true });
    log.mockImplementation(() => {
      throw new Error("observer unavailable");
    });
    await expect(
      observeRepositoryProductionPhase(
        "setup_prepare",
        "setup_unavailable",
        run,
        controller.signal,
      ),
    ).rejects.toBe(failure);
  });

  it("publishes only fixed progress labels and ignores progress logging failure", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    reportRepositoryProductionProgress("connections", "started");
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      event: "builder.repository_production_progress",
      phase: "connections",
      state: "started",
    });
    log.mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    expect(() => {
      reportRepositoryProductionProgress("worker_input", "completed");
    }).not.toThrow();
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
