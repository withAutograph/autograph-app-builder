/* oxlint-disable eslint/require-await -- Controlled read ports implement the asynchronous production contracts. */
import { describe, expect, it, vi } from "vitest";
import {
  readProductionInviteeAuthSnapshot,
  readAcceptedProductionInviteeAccess,
} from "./repository-production-invitee-readback";
import type { AcceptedInviteeReadbackInput } from "./repository-production-invitee-readback";
import type {
  ActorBindingRecordReadback,
  ReadAppRuntimeSnapshot,
  OperatorActorBindingScope,
} from "./hosted-operator-app-readiness";

const authTransport = vi.hoisted(() => ({ open: vi.fn() }));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Controlled SQL transport exercises the real fixed Auth snapshot reader without any provider or database effects.
vi.mock("postgres", () => ({ default: authTransport.open }));

const fixture = (roleless = false, frontend = false) => {
  const input: AcceptedInviteeReadbackInput = {
    scope: {
      authority: {
        issuer: "https://builder.test/api/auth",
        audience: "https://builder.test/mcp",
        workspaceId: "workspace",
        ownerUserId: "owner",
      },
      appId: "requests",
      organizationId: "org",
      repositoryFullName: "team/apps",
      repositoryId: "repo",
      projectId: "project",
      publicOrigin: "https://apps.test",
      environment: "production",
    },
    actorId: "invitee",
    roles: roleless ? [] : ["reader"],
    controlGeneration: 429,
    profile: {
      neon: {
        endpoint: "ep-test.neon.tech",
        endpointId: "endpoint",
        projectId: "neon",
        branchId: "branch",
        maintenanceDatabase: "neondb",
        maintenanceRole: "operator",
      },
      authResource: {
        resourceId: "auth",
        database: "auth",
        runtimeRole: "auth_runtime",
        migratorRole: "auth_migrator",
      },
      authOperatorRole: "auth_operator",
    },
    authUrl: "postgresql://auth_operator:synthetic@ep-test.neon.tech/auth?sslmode=verify-full",
    assertCurrent: async () => {},
    signal: new AbortController().signal,
  };
  if (!frontend) {
    input.runtime = {
      url: "postgresql://app_runtime:synthetic@ep-test.neon.tech/app_db?sslmode=verify-full",
      resource: {
        resourceId: "app",
        database: "app_db",
        runtimeRole: "app_runtime",
        migratorRole: "app_migrator",
      },
    };
  }
  const tuple = { actorId: "invitee", appId: "requests", organizationId: "org" };
  const auth = {
    identity: { role: "auth_operator", database: "auth" },
    member: true,
    entitled: true,
    grants: roleless ? [] : [{ ...tuple, role: "reader", active: true, generation: 426 }],
    admission: roleless
      ? [{ ...tuple, workspaceId: "workspace", roles: [], active: true, generation: 426 }]
      : [],
  };
  let binding: ActorBindingRecordReadback = {
    status: "present",
    binding: {
      ...tuple,
      active: true,
      fenceGeneration: 426,
    },
  };
  if (!roleless && binding.status === "present") {
    binding.binding.role = "reader";
  }
  const identity = {
    database: "app_db",
    role: "app_runtime",
    login: "app_runtime",
    owner: "app_migrator",
    comment: "protected-resource:v1:app_database:app:database",
    project: "neon",
    branch: "branch",
    endpoint: "endpoint",
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolreplication: false,
    rolbypassrls: false,
    privileged_membership: false,
    owns_public_objects: false,
    can_create: false,
    can_temp: false,
  };
  let runtimeReads = 0;
  const readRuntime: ReadAppRuntimeSnapshot = async (_url, read) => {
    runtimeReads += 1;
    return await read({
      readIdentity: async () => identity,
      readOrganization: async () => {
        throw new Error("no app data read is needed");
      },
      readActorBindingRecord: async (scope) => {
        const expected: OperatorActorBindingScope = { ...tuple };
        if (!roleless) {
          expected.role = "reader";
        }
        expect(scope).toEqual(expected);
        return binding;
      },
    });
  };
  const io = { readAuth: async () => auth, readRuntime };
  return {
    input,
    auth,
    identity,
    io,
    setBinding: (value: ActorBindingRecordReadback) => {
      binding = value;
    },
    runtimeReads: () => runtimeReads,
  };
};

describe("accepted Production invitee readback", () => {
  it.each([false, true])(
    "accepts matching fresh old-generation grants under current control authority (roleless=%s)",
    async (roleless) => {
      const f = fixture(roleless);
      await expect(readAcceptedProductionInviteeAccess(f.input, f.io)).resolves.toBe("applied");
      expect(f.input.controlGeneration).toBe(429);
    },
  );
  it.each([false, true])(
    "supports frontend-only access without a database read (roleless=%s)",
    async (roleless) => {
      const f = fixture(roleless, true);
      await expect(readAcceptedProductionInviteeAccess(f.input, f.io)).resolves.toBe("applied");
      expect(f.runtimeReads()).toBe(0);
    },
  );
  it.each(["missing", "revoked", "principal-denied"] as const)(
    "does not acknowledge %s database access",
    async (state) => {
      const f = fixture();
      let observed: ActorBindingRecordReadback = { status: "absent" };
      if (state === "principal-denied") {
        observed = { status: "principal_scope_denied" };
      }
      if (state === "revoked") {
        observed = {
          status: "present",
          binding: {
            actorId: "invitee",
            appId: "requests",
            organizationId: "org",
            role: "reader",
            active: false,
            fenceGeneration: 427,
          },
        };
      }
      f.setBinding(observed);
      await expect(readAcceptedProductionInviteeAccess(f.input, f.io)).resolves.toBe(
        state === "principal-denied" ? "unknown" : "absent",
      );
    },
  );
  it.each(["member", "entitlement", "grant", "role"] as const)(
    "does not acknowledge missing Auth %s",
    async (state) => {
      const f = fixture();
      if (state === "member") {
        f.auth.member = false;
      }
      if (state === "entitlement") {
        f.auth.entitled = false;
      }
      if (state === "grant") {
        f.auth.grants[0].active = false;
      }
      if (state === "role") {
        f.auth.grants[0].role = "other";
      }
      await expect(readAcceptedProductionInviteeAccess(f.input, f.io)).resolves.toBe("absent");
    },
  );
  it.each(["actorId", "appId", "organizationId"] as const)(
    "refuses a foreign Auth %s",
    async (field) => {
      const f = fixture();
      f.auth.grants[0][field] = "foreign";
      await expect(readAcceptedProductionInviteeAccess(f.input, f.io)).resolves.toBe("unknown");
    },
  );
  it.each([425, 0, 430])(
    "does not acknowledge a mismatched or invalid database generation %s",
    async (fenceGeneration) => {
      const f = fixture();
      f.setBinding({
        status: "present",
        binding: {
          actorId: "invitee",
          appId: "requests",
          organizationId: "org",
          role: "reader",
          active: true,
          fenceGeneration,
        },
      });
      await expect(readAcceptedProductionInviteeAccess(f.input, f.io)).resolves.toBe("unknown");
    },
  );
  it.each([0, 430])("rejects invalid or future Auth generation %s", async (value) => {
    const f = fixture();
    f.auth.grants[0].generation = value;
    await expect(readAcceptedProductionInviteeAccess(f.input, f.io)).resolves.toBe("unknown");
  });
  it("keeps driver failures unknown", async () => {
    const f = fixture();
    await expect(
      readAcceptedProductionInviteeAccess(f.input, {
        ...f.io,
        readAuth: async () => {
          throw new Error("private driver detail");
        },
      }),
    ).resolves.toBe("unknown");
    await expect(
      readAcceptedProductionInviteeAccess(f.input, {
        ...f.io,
        readRuntime: async () => {
          throw new Error("private driver detail");
        },
      }),
    ).resolves.toBe("unknown");
  });
  it("preserves current owner loss after the read and cancellation", async () => {
    const f = fixture();
    const denial = new Error("owner changed");
    let lost = false;
    f.input.assertCurrent = async () => {
      if (lost) {
        throw denial;
      }
    };
    await expect(
      readAcceptedProductionInviteeAccess(f.input, {
        ...f.io,
        readAuth: async () => {
          lost = true;
          return f.auth;
        },
      }),
    ).rejects.toBe(denial);
    const other = fixture();
    const abort = new AbortController();
    other.input.signal = abort.signal;
    await expect(
      readAcceptedProductionInviteeAccess(other.input, {
        ...other.io,
        readAuth: async () => {
          abort.abort();
          return other.auth;
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("refuses another runtime identity and credential endpoint", async () => {
    const f = fixture();
    f.identity.database = "foreign";
    await expect(readAcceptedProductionInviteeAccess(f.input, f.io)).resolves.toBe("unknown");
    const other = fixture();
    other.input.authUrl = other.input.authUrl.replace("ep-test.neon.tech", "foreign.neon.tech");
    await expect(readAcceptedProductionInviteeAccess(other.input, other.io)).resolves.toBe(
      "unknown",
    );
  });
});

it("reads exact Auth bindings in a read-only transaction and closes the connection", async () => {
  const f = fixture();
  const observed: string[][] = [];
  const tx = Object.assign(async () => [{ role: "auth_operator", database: "auth" }], {
    unsafe: async (query: string, values: string[]) => {
      expect(query.trimStart().startsWith("select ")).toBe(true);
      observed.push(values);
      if (query.includes("from public.member")) {
        return [{ member: true, entitled: true }];
      }
      if (query.includes("from public.app_actor_assignment")) {
        return f.auth.grants;
      }
      if (query.includes("from public.app_actor_access")) {
        return f.auth.admission;
      }
      throw new Error("unexpected SQL operation");
    },
  });
  let closed = false;
  authTransport.open.mockReturnValue({
    begin: async (mode: string, run: (connection: typeof tx) => Promise<object>) => {
      expect(mode).toContain("read only");
      return await run(tx);
    },
    end: async () => {
      closed = true;
    },
  });
  await expect(
    readProductionInviteeAuthSnapshot(f.input.authUrl, f.input.scope, f.input.actorId),
  ).resolves.toMatchObject({
    grants: [{ actorId: "invitee", appId: "requests", organizationId: "org", generation: 426 }],
  });
  expect(observed).toContainEqual(["org", "invitee", "requests"]);
  expect(observed).toContainEqual(["org", "invitee", "requests", "workspace"]);
  expect(closed).toBe(true);
});
