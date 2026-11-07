/* oxlint-disable eslint/require-await -- Synthetic ports retain the asynchronous failure boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";
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
