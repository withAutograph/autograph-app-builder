/* oxlint-disable eslint/require-await -- In-memory adapters implement asynchronous production ports. */
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { RepositoryProductionScope } from "../provisioning/repository-production-contract";
import { AppAccessError } from "./errors";
import { createAppAccessManagementService } from "./management";
import type { AppAccessManagementDependencies, AppAccessOperationRow } from "./management";
import type { AppAccessOwner } from "./operator-client";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId: "expenses",
  repositoryId: "123",
  repositoryFullName: "org/apps",
  projectId: "project",
  organizationId: "dev",
  publicOrigin: "https://apps.test",
  environment: "production",
};
const owner: AppAccessOwner = {
  appId: scope.appId,
  sessionId: "session",
  ownerContext: {
    kind: "direct",
    authority: scope.authority,
    principal: { ...scope.authority, scopes: ["autograph:session"] },
    sessionId: "session",
    adapterSessionId: "adapter",
    adapterGeneration: 1,
  },
};
const invite = () => ({
  clientRequestId: randomUUID(),
  action: "invite" as const,
  email: "guest@example.test",
  roles: ["reader"],
});
const setup = () => {
  const rows = new Map<string, AppAccessOperationRow>();
  const deps: AppAccessManagementDependencies = {
    resolve: async () => ({
      scope,
      appName: "Expenses",
      organizationName: "Dev",
      roles: [{ id: "reader", label: "Reader" }],
      creator: { status: "ready" },
      canManage: true,
    }),
    assertAuthorized: vi.fn(async () => {}),
    readPeople: async () => ({ members: [], invitations: [] }),
    withLease: async (_scope, run) => await run(async () => {}),
    journal: {
      reserve: async (record) => {
        const id = record.command.clientRequestId;
        const current = rows.get(id) ?? structuredClone({ record, revision: 1 });
        rows.set(id, current);
        return structuredClone(current);
      },
      pending: async () =>
        [...rows.values()]
          .filter(
            (row) => row.record.state === "pending" || row.record.enrollment?.state === "pending",
          )
          .map((row) => structuredClone(row)),
      update: async (row, record) => {
        const id = record.command.clientRequestId;
        if (rows.get(id)?.revision !== row.revision) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS failure is explicitly undefined in the store contract.
          return undefined;
        }
        const next = structuredClone({ record, revision: row.revision + 1 });
        rows.set(id, next);
        return structuredClone(next);
      },
      findInvitation: async (id) => {
        const current = rows.get(id);
        return current === undefined ? undefined : structuredClone(current);
      },
    },
    execute: vi.fn(async () => "applied" as const),
    reconcile: vi.fn(async () => "unknown" as const),
    readVerifiedInvitation: async () => ({
      actorId: "verified-guest",
      email: "guest@example.test",
      roles: ["reader"],
      accepted: false,
    }),
    enrollInvitee: vi.fn(async () => {}),
    reconcileInvitee: vi.fn(async () => "applied" as const),
    acceptInvitation: vi.fn(async () => {}),
  };
  return { deps, rows, service: createAppAccessManagementService(deps) };
};

describe("managed app access", () => {
  it("journals an invitation once and reuses its completed result", async () => {
    const { service, deps } = setup();
    const command = invite();
    await service.execute(owner, command);
    await service.execute(owner, command);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it("does not resend an invitation after a lost successful response", async () => {
    const { deps } = setup();
    deps.execute = vi.fn(async () => {
      throw new Error("response lost after send");
    });
    deps.reconcile = vi.fn(async () => "applied" as const);
    const service = createAppAccessManagementService(deps);
    const command = invite();
    await expect(service.execute(owner, command)).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    await service.execute(owner, command);
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it("blocks conflicting mutations until an uncertain request is reconciled", async () => {
    const { deps } = setup();
    deps.execute = vi.fn(async () => {
      throw new Error("unknown");
    });
    const service = createAppAccessManagementService(deps);
    await expect(service.execute(owner, invite())).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    await expect(service.execute(owner, invite())).rejects.toMatchObject({
      code: "app_access_unknown",
    });
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects reused request identities with a different recipient", async () => {
    const { service, deps } = setup();
    const command = invite();
    await service.execute(owner, command);
    await expect(
      service.execute(owner, { ...command, email: "other@example.test" }),
    ).rejects.toMatchObject({ code: "request_id_conflict" });
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects app roles outside the selected app and permits role-less app access", async () => {
    const { deps } = setup();
    let service = createAppAccessManagementService(deps);
    await expect(
      service.execute(owner, { ...invite(), roles: ["organization-admin"] }),
    ).rejects.toMatchObject({ code: "app_access_denied" });
    deps.resolve = async () => ({
      scope,
      appName: "Expenses",
      organizationName: "Dev",
      roles: [],
      creator: { status: "ready" },
      canManage: true,
    });
    service = createAppAccessManagementService(deps);
    await service.execute(owner, { ...invite(), roles: [] });
    expect(deps.execute).toHaveBeenCalledTimes(1);
  });

  it("checks current inviter authority when the invitee signs in", async () => {
    const { service, deps } = setup();
    const command = invite();
    await service.execute(owner, command);
    deps.assertAuthorized = async () => {
      throw new AppAccessError("app_access_denied");
    };
    await expect(service.completeInvitation(command.clientRequestId)).rejects.toMatchObject({
      code: "app_access_denied",
    });
    expect(deps.enrollInvitee).not.toHaveBeenCalled();
  });

  it("enrolls only the verified recipient and does not regrant completed invitations", async () => {
    const { service, deps } = setup();
    const command = invite();
    await service.execute(owner, command);
    await service.completeInvitation(command.clientRequestId);
    await service.completeInvitation(command.clientRequestId);
    expect(deps.enrollInvitee).toHaveBeenCalledTimes(1);
    expect(deps.enrollInvitee).toHaveBeenCalledWith(
      scope,
      command.clientRequestId,
      "verified-guest",
      ["reader"],
      expect.any(Object),
    );
    expect(deps.acceptInvitation).toHaveBeenCalledTimes(1);
  });

  it("rejects a cancelled invitation without granting access", async () => {
    const { service, deps } = setup();
    const command = invite();
    await service.execute(owner, command);
    deps.readVerifiedInvitation = async () => {};
    await expect(service.completeInvitation(command.clientRequestId)).rejects.toMatchObject({
      code: "app_access_denied",
    });
    expect(deps.enrollInvitee).not.toHaveBeenCalled();
  });

  it("reconciles interrupted enrollment before finishing invitation acceptance", async () => {
    const { service, deps } = setup();
    const command = invite();
    await service.execute(owner, command);
    deps.enrollInvitee = vi.fn(async () => {
      throw new Error("response lost after grant");
    });
    await expect(service.completeInvitation(command.clientRequestId)).rejects.toThrow();
    await service.completeInvitation(command.clientRequestId);
    expect(deps.enrollInvitee).toHaveBeenCalledTimes(1);
    expect(deps.acceptInvitation).toHaveBeenCalledTimes(1);
  });
});
