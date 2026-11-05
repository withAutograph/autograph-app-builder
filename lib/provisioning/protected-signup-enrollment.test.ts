import { describe, expect, it, vi } from "vitest";

import {
  continueProtectedSignupEnrollment,
  signupEnrollmentIdentity,
} from "./protected-signup-enrollment";
import type { SignupEnrollmentAccess, SignupEnrollmentStore } from "./protected-signup-enrollment";

const key = {
  authority: {
    issuer: "https://issuer.example",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "owner",
  },
  scope: {
    authResourceId: "auth-resource",
    appResourceId: "app-resource",
    appId: "fixture-app",
    organizationId: "approved-organization",
    actorId: "signed-in-person",
  },
};
const policy = {
  policyDigest: "a".repeat(64),
  policyId: "signup-policy",
  operationRef: "640589ea-86ef-4e31-b8f4-2ce0058fbab3",
  planDigest: "b".repeat(64),
  roles: [],
};

const fixture = () => {
  let row: Awaited<ReturnType<SignupEnrollmentStore["read"]>>;
  let time = Date.parse("2026-11-05T14:00:00Z");
  const read = vi.fn<SignupEnrollmentStore["read"]>(() => Promise.resolve(row));
  const reserve = vi.fn<SignupEnrollmentStore["reserve"]>(({ scope, policy: admitted }) => {
    row ??= {
      revision: 1,
      record: {
        version: 1,
        kind: "protected-signup-enrollment",
        scope,
        policy: admitted,
        generation: 73,
        state: "pending",
      },
    };
    return Promise.resolve(row);
  });
  const compareAndSet = vi.fn<SignupEnrollmentStore["compareAndSet"]>(
    ({ expectedRevision, record }) => {
      let updated: Awaited<ReturnType<SignupEnrollmentStore["compareAndSet"]>>;
      if (row?.revision === expectedRevision) {
        updated = { record, revision: expectedRevision + 1 };
        row = updated;
      }
      return Promise.resolve(updated);
    },
  );
  const store: SignupEnrollmentStore = { read, reserve, compareAndSet };
  const inspect = vi.fn<SignupEnrollmentAccess["inspect"]>();
  const grant = vi.fn<SignupEnrollmentAccess["grant"]>();
  const assertPolicyCurrent = vi.fn(() => Promise.resolve());
  return {
    inspect,
    grant,
    store,
    reserve,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
    run: (approved = policy) =>
      continueProtectedSignupEnrollment({
        key,
        policy: approved,
        store,
        access: { inspect, grant },
        assertPolicyCurrent,
        now: () => new Date(time),
      }),
  };
};

describe("protected signup enrollment", () => {
  it("keys one actor/app/organization independently of policy revision and tenant selection", () => {
    const identity = signupEnrollmentIdentity(key.scope);
    expect(identity.requestId).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/u,
    );
    expect(
      signupEnrollmentIdentity({ ...key.scope, organizationId: "other-organization" }).digest,
    ).not.toBe(identity.digest);
    expect(
      signupEnrollmentIdentity({ ...key.scope, appResourceId: "other-app-db" }).digest,
    ).not.toBe(identity.digest);
  });

  it("recovers a lost worker response using the same generation and no duplicate grant", async () => {
    const f = fixture();
    f.inspect.mockResolvedValueOnce("applicable").mockResolvedValue("granted");
    f.grant.mockImplementation(async (record, assertCurrent) => {
      expect(record.generation).toBe(73);
      await assertCurrent();
      throw new Error("worker response lost");
    });
    await expect(f.run()).resolves.toBe("pending");
    await expect(f.run()).resolves.toBe("pending");
    f.advance(121_000);
    await expect(f.run()).resolves.toBe("ready");
    expect(f.grant).toHaveBeenCalledTimes(1);
    expect(f.reserve).toHaveBeenCalledTimes(1);
    expect(f.inspect.mock.calls.every(([record]) => record.generation === 73)).toBe(true);
  });

  it("never uses a prior receipt to reopen an observed revocation or changed policy", async () => {
    const f = fixture();
    f.inspect.mockResolvedValueOnce("granted").mockResolvedValue("revoked");
    await expect(f.run()).resolves.toBe("ready");
    await expect(f.run()).resolves.toBe("blocked");
    await expect(f.run({ ...policy, policyDigest: "c".repeat(64) })).resolves.toBe("blocked");
    expect(f.grant).not.toHaveBeenCalled();
  });

  it("requires matching post-grant readback before marking access ready", async () => {
    const f = fixture();
    f.inspect.mockResolvedValueOnce("applicable").mockResolvedValueOnce("unknown");
    f.grant.mockImplementation(async (_record, assertCurrent) => {
      await assertCurrent();
    });
    await expect(f.run()).resolves.toBe("pending");
    await expect(f.store.read(key)).resolves.toMatchObject({
      record: { state: "pending", generation: 73 },
    });
  });
});
