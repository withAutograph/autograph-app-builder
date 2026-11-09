/* oxlint-disable eslint/require-await -- In-memory adapters implement asynchronous production ports. */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryProductionScope } from "../provisioning/repository-production-contract";
import { AppAccessError } from "./errors";
import { completeRepositoryProductionInvitation } from "../provisioning/repository-production-native";
import { PhysicalResourceLeaseBusyError } from "../provisioning/postgres-physical-resource-lease";
import { createAppAccessManagementService } from "./management";
import type { AppAccessManagementDependencies, AppAccessOperationRow } from "./management";
import type { AppAccessOwner } from "./operator-client";

const scope: RepositoryProductionScope = {
  appId: "expenses",
  authority: {
    audience: "https://builder.test/mcp",
    issuer: "https://builder.test/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  environment: "production",
  organizationId: "dev",
  projectId: "project",
  publicOrigin: "https://apps.test",
  repositoryFullName: "org/apps",
  repositoryId: "123",
};
const owner: AppAccessOwner = {
  appId: scope.appId,
  ownerContext: {
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority: scope.authority,
    kind: "direct",
    principal: { ...scope.authority, scopes: ["autograph:session"] },
    sessionId: "session",
  },
  sessionId: "session",
};
const invite = () => ({
  action: "invite" as const,
  clientRequestId: randomUUID(),
  email: "guest@example.test",
  roles: ["reader"],
});
afterEach(() => vi.restoreAllMocks());
const setup = () => {
  const rows = new Map<string, AppAccessOperationRow>();
  const deps: AppAccessManagementDependencies = {
    acceptInvitation: vi.fn(async () => {}),
    assertAuthorized: vi.fn(async () => {}),
    enrollInvitee: vi.fn(async () => {}),
    execute: vi.fn(async () => "applied" as const),
    journal: {
      findInvitation: async (id) => {
        const current = rows.get(id);
        return current === undefined ? undefined : structuredClone(current);
      },
      pending: async () =>
        [...rows.values()]
          .filter(
            (row) => row.record.state === "pending" || row.record.enrollment?.state === "pending",
          )
          .map((row) => structuredClone(row)),
      reserve: async (record) => {
        const id = record.command.clientRequestId;
        const current = rows.get(id) ?? structuredClone({ record, revision: 1 });
        rows.set(id, current);
        return structuredClone(current);
      },
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
    },
    readPeople: async () => ({ invitations: [], members: [] }),
    readVerifiedInvitation: async () => ({
      accepted: false,
      actorId: "verified-guest",
      email: "guest@example.test",
      roles: ["reader"],
    }),
    reconcile: vi.fn(async () => "unknown" as const),
    reconcileInvitee: vi.fn(async () => "applied" as const),
    resolve: async () => ({
      appName: "Expenses",
      canManage: true,
      creator: { status: "ready" },
      organizationName: "Dev",
      roles: [{ id: "reader", label: "Reader" }],
      scope,
    }),
    withLease: async (_scope, run) => await run(async () => {}),
  };
  return { deps, rows, service: createAppAccessManagementService(deps) };
};

describe("managed app access", () => {
  it.each(["resolve", "people"] as const)(
    "reports the actual protected %s read boundary and preserves its rejection",
    async (stage) => {
      const log = vi.spyOn(console, "warn").mockImplementation(() => {});
      const f = setup();
      const failure = new Error(
        stage === "resolve" ? "repository_production_source_unavailable" : "private-provider-token",
        { cause: "private-cause" },
      );
      if (stage === "resolve") {
        f.deps.resolve = async () => {
          throw failure;
        };
      }
      if (stage === "people") {
        f.deps.readPeople = async () => {
          throw failure;
        };
      }
      await expect(f.service.read(owner)).rejects.toBe(failure);
      const output = log.mock.calls.flat().join("");
      expect(output).toContain(
        `"phase":"${stage === "resolve" ? "access_scope_resolve" : "access_people"}"`,
      );
      if (stage === "resolve") {
        expect(output).toContain('"reason":"source_unavailable"');
      }
      expect(output).not.toContain("private");
      expect(output).not.toContain("workspace");
    },
  );
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
      appName: "Expenses",
      canManage: true,
      creator: { status: "ready" },
      organizationName: "Dev",
      roles: [],
      scope,
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

  it("returns pending before capture, Auth reads or writes when the automatic completion slot is busy", async () => {
    const { service, deps, rows } = setup();
    const command = invite();
    await service.execute(owner, command);
    const before = structuredClone([...rows]);
    const authorize = vi.fn(async () => {});
    const readInvitation = vi.fn(deps.readVerifiedInvitation);
    const update = vi.spyOn(deps.journal, "update");
    deps.assertAuthorized = authorize;
    deps.readVerifiedInvitation = readInvitation;
    deps.withLease = async () => {
      throw new PhysicalResourceLeaseBusyError();
    };
    vi.mocked(deps.execute).mockClear();
    await expect(
      completeRepositoryProductionInvitation({
        creator: async () => "not-owned",
        invitee: async () => {
          await service.completeInvitation(command.clientRequestId);
        },
      }),
    ).resolves.toBe("pending");
    expect(authorize).not.toHaveBeenCalled();
    expect(readInvitation).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.enrollInvitee).not.toHaveBeenCalled();
    expect(deps.acceptInvitation).not.toHaveBeenCalled();
    expect([...rows]).toEqual(before);
  });

  it.each([
    ["pending", "owner revoked"],
    ["pending", "repository_production_approval_required"],
    ["applied", "owner revoked"],
    ["applied", "repository_production_approval_required"],
  ] as const)(
    "checks %s enrollment authority under the held lease before returning or effects (%s)",
    async (enrollment, reason) => {
      const { service, deps, rows } = setup();
      const command = invite();
      await service.execute(owner, command);
      if (enrollment === "applied") {
        await service.completeInvitation(command.clientRequestId);
      }
      const before = structuredClone([...rows]);
      let held = false;
      deps.withLease = async (_scope, run) => {
        held = true;
        try {
          return await run(async () => {});
        } finally {
          held = false;
        }
      };
      const failure = new Error(reason);
      deps.assertAuthorized = vi.fn(async () => {
        expect(held).toBe(true);
        throw failure;
      });
      const readInvitation = vi.fn(deps.readVerifiedInvitation);
      deps.readVerifiedInvitation = readInvitation;
      const update = vi.spyOn(deps.journal, "update");
      vi.mocked(deps.enrollInvitee).mockClear();
      vi.mocked(deps.acceptInvitation).mockClear();
      await expect(service.completeInvitation(command.clientRequestId)).rejects.toBe(failure);
      expect(deps.assertAuthorized).toHaveBeenCalled();
      expect(readInvitation).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(deps.enrollInvitee).not.toHaveBeenCalled();
      expect(deps.acceptInvitation).not.toHaveBeenCalled();
      expect([...rows]).toEqual(before);
      expect(held).toBe(false);
    },
  );

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
