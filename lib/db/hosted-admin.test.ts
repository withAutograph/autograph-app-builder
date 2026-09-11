import { describe, expect, it, vi } from "vitest";

import {
  executeHostedAdminRequest,
  hostedAdminApplyRequestSchema,
  planHostedAdminRequest,
} from "./hosted-admin";
import type { HostedAdminPlanRequest, HostedAdminStore } from "./hosted-admin";

const now = Date.parse("2026-08-26T20:00:00.000Z");
const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user_1",
  workspaceId: "workspace_1",
};

type RequestInput = HostedAdminPlanRequest extends infer Request
  ? Request extends HostedAdminPlanRequest
    ? Omit<Request, "version" | "authority" | "requestedAt">
    : never
  : never;

function request(value: RequestInput): HostedAdminPlanRequest {
  return {
    authority,
    requestedAt: new Date(now).toISOString(),
    version: 1,
    ...value,
  } as HostedAdminPlanRequest;
}

function store(): HostedAdminStore {
  return {
    applyRetention: vi.fn(async () => ({
      operationRowsDeleted: 4,
      sessionRowsDeleted: 2,
      integrationRowsDeleted: 0,
      authorizationStateRowsDeleted: 0,
    })),
    deleteTenant: vi.fn(async () => ({
      membershipRowsDeleted: 1,
      operationRowsDeleted: 5,
      sessionRowsDeleted: 2,
    })),
    revokeMembership: vi.fn(async () => ({ membershipRowsAffected: 1 })),
    seedMembership: vi.fn(async () => ({ membershipRowsAffected: 1 })),
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
      now: () => now,
      request: confirmed(request({ action: "membership.seed" })),
      store: adapter,
    });
    expect(adapter.seedMembership).toHaveBeenCalledWith({
      authority,
      now: new Date(now),
    });
    expect(receipt).toMatchObject({
      action: "membership.seed",
      database: {
        dialect: "postgresql",
        maxConnections: 1,
        secretTransport: "task-scoped-stdin",
      },
      effects: { membershipRowsAffected: 1 },
      status: "applied",
      version: 1,
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
        now: () => now,
        request: { ...input, confirmationDigest: `sha256:${"0".repeat(64)}` },
        store: store(),
      })
    ).rejects.toThrow("confirmation");
    await expect(
      executeHostedAdminRequest({
        now: () => now + 16 * 60_000,
        request: input,
        store: store(),
      })
    ).rejects.toThrow("stale");
    expect(() =>
      planHostedAdminRequest({
        ...request({ action: "membership.seed" }),
        authority: {
          ...authority,
          issuer: "https://identity.example.test/api/auth",
        },
      })
    ).toThrow("share one origin");
    expect(() =>
      hostedAdminApplyRequestSchema.parse({ ...input, ambientRole: "admin" })
    ).toThrow();
  });

  it("keeps retention cutoffs historical and reports only bounded counts", async () => {
    const adapter = store();
    const input = request({
      action: "retention.apply",
      deleteBefore: "2026-07-01T00:00:00.000Z",
    });
    const receipt = await executeHostedAdminRequest({
      now: () => now,
      request: confirmed(input),
      store: adapter,
    });
    expect(adapter.applyRetention).toHaveBeenCalledWith({
      authority,
      deleteBefore: new Date("2026-07-01T00:00:00.000Z"),
    });
    expect(receipt.effects).toEqual({
      authorizationStateRowsDeleted: 0,
      integrationRowsDeleted: 0,
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
        now: () => now,
        request: confirmed(future),
        store: adapter,
      })
    ).rejects.toThrow("cutoff");
  });

  it("requires a five-minute membership-revocation drain before tenant deletion", async () => {
    const adapter = store();
    const drained = request({
      action: "tenant.delete",
      membershipRevokedBefore: "2026-08-26T19:54:59.000Z",
    });
    const receipt = await executeHostedAdminRequest({
      now: () => now,
      request: confirmed(drained),
      store: adapter,
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
        now: () => now,
        request: confirmed(undrained),
        store: adapter,
      })
    ).rejects.toThrow("five-minute");
  });
});
