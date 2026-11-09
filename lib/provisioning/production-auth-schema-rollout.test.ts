/* oxlint-disable eslint/require-await -- Controlled asynchronous ports model protected service boundaries. */
/* oxlint-disable typescript/no-non-null-assertion, unicorn/no-await-expression-member, promise/avoid-new -- Assertions follow successful controlled creation; deferred callbacks expose simultaneous lease contention. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { publicApprovalDescription } from "../agent/approval-receipt";
import { createAuthSchemaRollout } from "./production-auth-schema-rollout";
import type { AuthSchemaRolloutPorts } from "./production-auth-schema-rollout";
import { authSchemaRolloutLockKey } from "./production-auth-schema-rollout-store";
import { authSchemaRolloutWorkerContext } from "./production-auth-schema-rollout-native";
import {
  assertAuthSchemaRolloutEnrollment,
  resolveAuthSchemaRolloutProfile,
} from "./production-auth-schema-rollout-configuration";
import {
  configuration,
  owner,
  profile,
  proposal,
  rolloutFixture,
} from "./production-auth-schema-rollout.test-fixture";

describe("private existing Production Auth schema rollout", () => {
  it("plans only enrolled administrator resources, freezes the original worker and shows concrete effects", async () => {
    const f = rolloutFixture();
    const { plan } = await f.service.plan(owner, profile.id);
    expect(plan.resource).toEqual(profile.resource);
    expect(plan.authOperatorRole).toBe(profile.authOperatorRole);
    expect(plan.sourceCapture).toEqual(profile.runtime.worker.sourceCapture);
    const description = publicApprovalDescription(plan, "apply-production-auth-schema-rollout");
    expect(description).toContain(profile.label);
    expect(description).toContain("operator-privileges");
    expect(description).not.toContain(profile.resource.hostname);
    expect(f.ports.apply).not.toHaveBeenCalled();
    expect((await f.service.plan(owner, profile.id)).plan.operationRef).toBe(plan.operationRef);
  });
  it("rejects unauthorized organizations and nonadministrators before planning credentials can be requested", async () => {
    const f = rolloutFixture();
    await expect(
      f.service.plan(
        { ...owner, authority: { ...owner.authority, workspaceId: "other" } },
        profile.id,
      ),
    ).rejects.toThrow();
    expect(() =>
      resolveAuthSchemaRolloutProfile(configuration, {
        authority: { ...owner.authority, ownerUserId: "creator" },
        sessionId: owner.sessionId,
        profileId: profile.id,
      }),
    ).toThrow();
    expect(f.ports.propose).not.toHaveBeenCalled();
  });
  it.each(["resource", "role"])(
    "rejects changed %s returned by a planner before journaling an approval",
    async (kind) => {
      const f = rolloutFixture();
      const parsed = z
        .looseObject({
          resource: z.looseObject({ database: z.string() }),
          schemaPlan: z.looseObject({ authOperatorRole: z.string() }),
        })
        .parse(structuredClone(proposal));
      if (kind === "resource") {
        parsed.resource.database = "other_auth";
      } else {
        parsed.schemaPlan.authOperatorRole = "postgres";
      }
      vi.mocked(f.ports.propose).mockResolvedValue(z.json().parse(parsed));
      await expect(f.service.plan(owner, profile.id)).rejects.toMatchObject({
        code: "resource_mismatch",
      });
      expect(f.rows.size).toBe(0);
      expect(f.ports.apply).not.toHaveBeenCalled();
    },
  );
  it("requires native approval before opening mutation credentials and retains one exact app-free operation", async () => {
    const f = rolloutFixture();
    const { plan } = await f.service.plan(owner, profile.id);
    f.setApproved(false);
    await expect(
      f.service.execute(owner, plan.operationRef, plan.planDigest, "call"),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.ports.apply).not.toHaveBeenCalled();
    f.setApproved(true);
    const ready = await f.service.execute(owner, plan.operationRef, plan.planDigest, "call");
    expect(ready.state).toBe("ready");
    const [row] = [...f.rows.values()];
    expect(row).toBeDefined();
    const context = authSchemaRolloutWorkerContext(row);
    expect(context.app_id).toBe("auth");
    expect(context.tenant_targets).toEqual([]);
    expect(context.operation.operation_id).toBe(plan.operationRef);
    await f.service.execute(owner, plan.operationRef, plan.planDigest, "later-call");
    expect(f.ports.apply).toHaveBeenCalledTimes(1);
  });
  it("rejects mismatched revision, revoked approval and altered enrolled resource or role", async () => {
    const f = rolloutFixture();
    const { plan } = await f.service.plan(owner, profile.id);
    await expect(
      f.service.execute(owner, plan.operationRef, "a".repeat(64), "call"),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    const row = f.rows.get(plan.operationRef)!;
    expect(() =>
      assertAuthSchemaRolloutEnrollment(
        { ...configuration, profiles: [{ ...profile, authOperatorRole: "wrong_operator" }] },
        row.record,
      ),
    ).toThrow();
    expect(() =>
      assertAuthSchemaRolloutEnrollment(
        {
          ...configuration,
          profiles: [{ ...profile, resource: { ...profile.resource, resourceId: "other" } }],
        },
        row.record,
      ),
    ).toThrow();
    await f.service.execute(owner, plan.operationRef, plan.planDigest, "call");
    f.setApproved(false);
    await expect(
      f.service.execute(owner, plan.operationRef, plan.planDigest, "retry"),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.ports.apply).toHaveBeenCalledTimes(1);
  });
  it("keeps old pinned workers when the enrolled deployment selects a new catalog", async () => {
    const f = rolloutFixture();
    const { plan } = await f.service.plan(owner, profile.id);
    const row = f.rows.get(plan.operationRef)!;
    const updated = {
      ...configuration,
      profiles: [
        {
          ...profile,
          runtime: {
            ...profile.runtime,
            worker: { ...profile.runtime.worker, sha256: "8".repeat(64) },
          },
        },
      ],
    };
    expect(assertAuthSchemaRolloutEnrollment(updated, row.record).runtime.worker.sha256).toBe(
      "8".repeat(64),
    );
    expect(row.record.runtime.worker.sha256).toBe(profile.runtime.worker.sha256);
  });
  it("reconciles uncertain apply against the same original plan and never blindly reapplies", async () => {
    const f = rolloutFixture();
    const { plan } = await f.service.plan(owner, profile.id);
    f.setUncertain(true);
    expect(
      (await f.service.execute(owner, plan.operationRef, plan.planDigest, "first")).state,
    ).toBe("reconciling");
    expect(
      (await f.service.execute(owner, plan.operationRef, plan.planDigest, "retry")).state,
    ).toBe("reconciling");
    expect(f.ports.apply).toHaveBeenCalledTimes(1);
    f.setObserved("applied");
    expect(
      (await f.service.execute(owner, plan.operationRef, plan.planDigest, "retry")).state,
    ).toBe("ready");
    expect(f.ports.inspect).toHaveBeenCalledTimes(2);
    expect(f.ports.apply).toHaveBeenCalledTimes(1);
    expect(f.rows.get(plan.operationRef)?.record.plan).toEqual(plan);
    expect(f.rows.get(plan.operationRef)?.record.approval?.approvedByCallId).toBe("first");
  });
  it.each(["credential lookup", "VM creation"])(
    "retries known pre-dispatch %s failure with the same saved approval",
    async () => {
      const f = rolloutFixture();
      const { plan } = await f.service.plan(owner, profile.id);
      const successfulApply = f.ports.apply;
      f.ports.apply = vi
        .fn<AuthSchemaRolloutPorts["apply"]>()
        .mockRejectedValueOnce(new Error("pre-dispatch unavailable"))
        .mockImplementationOnce(successfulApply);
      const initial = await f.service.execute(
        owner,
        plan.operationRef,
        plan.planDigest,
        "first-call",
      );
      expect(initial.state).toBe("planned");
      expect(f.rows.get(plan.operationRef)?.record.approval?.approvedByCallId).toBe("first-call");
      const resumed = await f.service.execute(
        owner,
        plan.operationRef,
        plan.planDigest,
        "resumed-call",
      );
      expect(resumed.state).toBe("ready");
      expect(f.ports.inspect).not.toHaveBeenCalled();
      expect(f.rows.get(plan.operationRef)?.record.approval?.approvedByCallId).toBe("first-call");
    },
  );
  it("serializes concurrent resumes by physical Auth identity, not session or operation", async () => {
    const f = rolloutFixture();
    const { plan } = await f.service.plan(owner, profile.id);
    const row = f.rows.get(plan.operationRef)!;
    expect(
      authSchemaRolloutLockKey({
        ...row,
        record: {
          ...row.record,
          plan: {
            ...plan,
            operationRef: "11111111-1111-4111-8111-111111111111",
            scope: { ...plan.scope, sessionId: "other-session" },
          },
        },
      }),
    ).toBe(authSchemaRolloutLockKey(row));
    let release: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = f.ports.apply;
    f.ports.apply = vi.fn<AuthSchemaRolloutPorts["apply"]>(
      async (pendingRow, assertCurrent, checkpoint, beforeWorkerDispatch) => {
        await hold;
        await original(pendingRow, assertCurrent, checkpoint, beforeWorkerDispatch);
      },
    );
    const first = createAuthSchemaRollout(f.ports).execute(
      owner,
      plan.operationRef,
      plan.planDigest,
      "first",
    );
    await vi.waitFor(() => {
      expect(f.ports.apply).toHaveBeenCalledTimes(1);
    });
    await expect(
      f.service.execute(owner, plan.operationRef, plan.planDigest, "second"),
    ).rejects.toThrow("lease_busy");
    release?.();
    expect((await first).state).toBe("ready");
    expect(f.ports.apply).toHaveBeenCalledTimes(1);
  });
});
