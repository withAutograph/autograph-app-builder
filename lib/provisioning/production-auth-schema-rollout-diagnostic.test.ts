/* oxlint-disable eslint/require-await -- Controlled promises exercise the diagnostic rejection boundary. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { HostedOperatorError } from "./hosted-operator-contract";
import {
  observeAuthSchemaRolloutPhase,
  observeAuthSchemaRolloutPhaseSync,
  reportAuthSchemaRolloutFailure,
} from "./production-auth-schema-rollout-diagnostic";

afterEach(() => vi.restoreAllMocks());

describe("private Auth maintenance failure diagnostics", () => {
  it("projects only fixed labels and SQLSTATE through an opaque query cause", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new Error("postgresql://private-owner:private-password@private-host/db", {
      cause: { code: "42501", query: "private SQL", owner: { private: "identity" } },
    });
    Object.assign(error, {
      code: "private-token",
      args: ["private argument"],
      stack: "private stack",
    });
    reportAuthSchemaRolloutFailure("canonical_owner", error);
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: "builder.auth_schema_rollout_failure",
        phase: "canonical_owner",
        errorClass: "native_error",
        sqlState: "42501",
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });

  it("recognizes only closed operator and validation classes without schema issue contents", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    reportAuthSchemaRolloutFailure(
      "profile_selection",
      new HostedOperatorError("authorization_required"),
    );
    const result = z.literal("expected").safeParse("private value");
    if (result.success) {
      throw new Error("Fixture must fail");
    }
    reportAuthSchemaRolloutFailure("configuration", result.error);
    const entries = warn.mock.calls.map(([entry]) => z.json().parse(JSON.parse(String(entry))));
    expect(entries).toMatchObject([
      {
        phase: "profile_selection",
        errorClass: "operator_error",
        operatorCode: "authorization_required",
      },
      { phase: "configuration", errorClass: "validation_error" },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private value");
  });

  it("never invokes hostile exception accessors or coerces arbitrary thrown values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const getter = vi.fn(() => {
      throw new Error("private getter");
    });
    const error = Object.defineProperties(
      {},
      Object.fromEntries(
        ["name", "message", "stack", "code", "cause"].map((name) => [name, { get: getter }]),
      ),
    );
    reportAuthSchemaRolloutFailure("sandbox_create", error);
    reportAuthSchemaRolloutFailure("sandbox_oidc", null);
    expect(getter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private");
  });

  it("preserves synchronous and asynchronous failures when the logger itself fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    const original = new Error("original operation failed");
    expect(() =>
      observeAuthSchemaRolloutPhaseSync("profile_selection", () => {
        throw original;
      }),
    ).toThrow(original);
    await expect(
      observeAuthSchemaRolloutPhase("sandbox_oidc", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });

  it("does not log successful operations or alter their results", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(observeAuthSchemaRolloutPhaseSync("configuration", () => 3)).toBe(3);
    await expect(observeAuthSchemaRolloutPhase("journal_save", async () => 4)).resolves.toBe(4);
    expect(warn).not.toHaveBeenCalled();
  });
});
