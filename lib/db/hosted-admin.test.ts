import { describe, expect, it, vi } from "vitest";

import {
  executeHostedAdminRequest,
  hostedAdminApplyRequestSchema,
  planHostedAdminRequest,
  type HostedAdminPlanRequest,
  type HostedAdminStore,
} from "./hosted-admin";

const now = Date.parse("2026-08-26T20:00:00.000Z");
const authority = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  workspaceId: "workspace_1",
  ownerUserId: "user_1",
};

type RequestInput = HostedAdminPlanRequest extends infer Request
  ? Request extends HostedAdminPlanRequest
    ? Omit<Request, "version" | "authority" | "requestedAt">
    : never
  : never;

function request(value: RequestInput): HostedAdminPlanRequest {
  return {
    version: 1,
    authority,
    requestedAt: new Date(now).toISOString(),
    ...value,
  } as HostedAdminPlanRequest;
}

function store(): HostedAdminStore {
  return {
    seedMembership: vi.fn(async () => ({ membershipRowsAffected: 1 })),
    revokeMembership: vi.fn(async () => ({ membershipRowsAffected: 1 })),
    applyRetention: vi.fn(async () => ({
      operationRowsDeleted: 4,
      sessionRowsDeleted: 2,
    })),
    deleteTenant: vi.fn(async () => ({
      membershipRowsDeleted: 1,
      operationRowsDeleted: 5,
      sessionRowsDeleted: 2,
    })),
  };
}

function confirmed(planRequest: HostedAdminPlanRequest) {
  return {
    ...planRequest,
    confirmationDigest:
      planHostedAdminRequest(planRequest).requiredConfirmationDigest,
  };
}

describe("hosted database administration contract", () => {
  it("plans a deterministic sanitized confirmation without disclosing authority", () => {
    const input = request({ action: "membership.seed" });
    const first = planHostedAdminRequest(input);
    const second = planHostedAdminRequest(input);
    expect(first).toEqual(second);
    expect(first.action).toBe("membership.seed");
    expect(JSON.stringify(first)).not.toContain(authority.workspaceId);
    expect(JSON.stringify(first)).not.toContain(authority.ownerUserId);
    expect(first.requiredConfirmationDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
  });

  it("applies only an exact fresh confirmation and emits a closed sanitized receipt", async () => {
    const adapter = store();
    const receipt = await executeHostedAdminRequest({
      request: confirmed(request({ action: "membership.seed" })),
      store: adapter,
      now: () => now,
    });
    expect(adapter.seedMembership).toHaveBeenCalledWith({
      authority,
      now: new Date(now),
    });
    expect(receipt).toMatchObject({
      version: 1,
      action: "membership.seed",
      status: "applied",
      effects: { membershipRowsAffected: 1 },
      database: {
        dialect: "postgresql",
        secretTransport: "task-scoped-stdin",
        maxConnections: 1,
      },
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(authority.issuer);
    expect(serialized).not.toContain(authority.workspaceId);
    expect(serialized).not.toContain(authority.ownerUserId);
  });

  it("rejects stale, mismatched, cross-origin, and unknown request authority", async () => {
    const input = confirmed(request({ action: "membership.revoke" }));
    await expect(
      executeHostedAdminRequest({
        request: { ...input, confirmationDigest: `sha256:${"0".repeat(64)}` },
        store: store(),
        now: () => now,
      }),
    ).rejects.toThrow("confirmation");
    await expect(
      executeHostedAdminRequest({
        request: input,
        store: store(),
        now: () => now + 16 * 60_000,
      }),
    ).rejects.toThrow("stale");
    expect(() =>
      planHostedAdminRequest({
        ...request({ action: "membership.seed" }),
        authority: {
          ...authority,
          issuer: "https://identity.example.test/api/auth",
        },
      }),
    ).toThrow("share one origin");
    expect(() =>
      hostedAdminApplyRequestSchema.parse({ ...input, ambientRole: "admin" }),
    ).toThrow();
  });

  it("keeps retention cutoffs historical and reports only bounded counts", async () => {
    const adapter = store();
    const input = request({
      action: "retention.apply",
      deleteBefore: "2026-07-01T00:00:00.000Z",
    });
    const receipt = await executeHostedAdminRequest({
      request: confirmed(input),
      store: adapter,
      now: () => now,
    });
    expect(adapter.applyRetention).toHaveBeenCalledWith({
      authority,
      deleteBefore: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(receipt.effects).toEqual({
      membershipRowsAffected: 0,
      membershipRowsDeleted: 0,
      operationRowsDeleted: 4,
      sessionRowsDeleted: 2,
    });

    const future = request({
      action: "retention.apply",
      deleteBefore: "2026-08-27T00:00:00.000Z",
    });
    await expect(
      executeHostedAdminRequest({
        request: confirmed(future),
        store: adapter,
        now: () => now,
      }),
    ).rejects.toThrow("cutoff");
  });

  it("requires a five-minute membership-revocation drain before tenant deletion", async () => {
    const adapter = store();
    const drained = request({
      action: "tenant.delete",
      membershipRevokedBefore: "2026-08-26T19:54:59.000Z",
    });
    const receipt = await executeHostedAdminRequest({
      request: confirmed(drained),
      store: adapter,
      now: () => now,
    });
    expect(adapter.deleteTenant).toHaveBeenCalledWith({
      authority,
      membershipRevokedBefore: new Date("2026-08-26T19:54:59.000Z"),
    });
    expect(receipt.effects.membershipRowsDeleted).toBe(1);

    const undrained = request({
      action: "tenant.delete",
      membershipRevokedBefore: "2026-08-26T19:56:00.000Z",
    });
    await expect(
      executeHostedAdminRequest({
        request: confirmed(undrained),
        store: adapter,
        now: () => now,
      }),
    ).rejects.toThrow("five-minute");
  });
});
