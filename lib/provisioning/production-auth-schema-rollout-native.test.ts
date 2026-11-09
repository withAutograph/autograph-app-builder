/* oxlint-disable eslint/require-await -- Controlled native ports keep these failure tests provider-free. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostedOperatorError } from "./hosted-operator-contract";
import {
  configuration,
  owner,
  profile,
  proposal,
  rolloutFixture,
} from "./production-auth-schema-rollout.test-fixture";
import { createAuthSchemaRolloutNativeHandler } from "./production-auth-schema-rollout-native";
import type { OperatorOwnerContext } from "./hosted-operator-contract";

const request = (profileId = profile.id) =>
  new Request("https://operator.example/v1/auth-schema-rollout", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer synthetic-private-token",
    },
    body: JSON.stringify({
      version: 1,
      action: "plan",
      sessionId: owner.sessionId,
      ownerContext: owner,
      profileId,
    }),
  });
const environment = {
  PRODUCTION_AUTH_SCHEMA_ROLLOUT_CONFIGURATION: JSON.stringify(configuration),
  DATABASE_URL: "postgresql://synthetic:synthetic@localhost/synthetic?sslmode=verify-full",
  BETTER_AUTH_URL: owner.authority.issuer,
  MCP_RESOURCE_URL: owner.authority.audience,
};
const fixture = () => {
  const { ports, rows } = rolloutFixture();
  const resolveOwner = vi.fn<() => Promise<OperatorOwnerContext>>(async () => owner);
  const verifyWorkload = vi.fn(async () => {});
  const close = vi.fn(async () => {});
  const propose = vi.fn(async () => proposal);
  const dependencies = {
    consent: { resolveOwner, verifyWorkload },
    propose,
    openJournal: async () => ({ store: ports.store, close }),
  };
  return { rows, ports, resolveOwner, verifyWorkload, close, propose, dependencies };
};
afterEach(() => vi.restoreAllMocks());

describe("Auth maintenance native plan failure attribution", () => {
  it("reports invalid configuration before owner or proposal access", async () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      createAuthSchemaRolloutNativeHandler({}, f.dependencies)(request()),
    ).rejects.toMatchObject({ code: "operator_unavailable" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"phase":"configuration"'));
    expect(f.resolveOwner).not.toHaveBeenCalled();
    expect(f.propose).not.toHaveBeenCalled();
  });

  it("distinguishes canonical-owner failure after verified workload from profile selection", async () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = new HostedOperatorError("authorization_required", {
      cause: "synthetic-private-owner",
    });
    f.resolveOwner.mockRejectedValue(original);
    await expect(
      createAuthSchemaRolloutNativeHandler(environment, f.dependencies)(request()),
    ).rejects.toBe(original);
    expect(f.verifyWorkload).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"phase":"canonical_owner"'));
    expect(f.propose).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private");
  });

  it("attributes actual non-enrolled profile selection before any proposal", async () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      createAuthSchemaRolloutNativeHandler(environment, f.dependencies)(request("not-enrolled")),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"phase":"profile_selection"'));
    expect(f.propose).not.toHaveBeenCalled();
    expect(f.rows.size).toBe(0);
    expect(f.close).toHaveBeenCalledOnce();
  });

  it("separates returned proposal validation from journal persistence", async () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    f.propose.mockResolvedValue({ version: 2 });
    await expect(
      createAuthSchemaRolloutNativeHandler(environment, f.dependencies)(request()),
    ).rejects.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"phase":"proposal_validation"'));
    expect(f.rows.size).toBe(0);
  });

  it("reports failed original journal reservation without inventing a replacement operation", async () => {
    const f = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = Object.assign(new Error("synthetic-private-query"), { code: "42501" });
    const reserve = vi.spyOn(f.ports.store, "reserve").mockRejectedValue(original);
    await expect(
      createAuthSchemaRolloutNativeHandler(environment, f.dependencies)(request()),
    ).rejects.toBe(original);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('"phase":"journal_save"'));
    expect(f.propose).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
    expect(f.close).toHaveBeenCalledOnce();
    expect(f.rows.size).toBe(0);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("synthetic-private");
  });
});
