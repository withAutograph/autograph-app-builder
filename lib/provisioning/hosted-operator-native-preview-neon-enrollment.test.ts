/* oxlint-disable eslint/require-await -- Async source fixtures supply the provider/consumer Promise interfaces without network effects. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { connectAuthProvider } from "@vercel/connect/mcp";
import { createNativePreviewNeonReader } from "./hosted-operator-native-preview-neon";
import { createPreviewNeonMcpReader } from "./hosted-operator-native-preview-neon-mcp";
import { hostedOperatorSourceConfigurationSchema } from "./hosted-operator-source-configuration";
import type {
  NativePreviewNeonDependencies,
  NativePreviewNeonScope,
} from "./hosted-operator-native-preview-neon";
import type { PreviewNeonMcpDependencies } from "./hosted-operator-native-preview-neon-mcp";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { SyntheticNeonEnrollment } from "./hosted-operator-synthetic-neon-provenance";

const createdAt = "2026-10-09T12:00:00Z";
const childCreatedAt = "2026-10-09T12:10:00Z";
const context: HostedOperatorContext = {
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  target: {
    appId: "spend-review",
    branch: "preview",
    environment: "preview",
    installationId: "owner-vercel-installation",
    projectId: "prj-app",
    scopeId: "team-owner",
    scopeType: "team",
    sessionId: "original-session",
  },
};
const enrollment: SyntheticNeonEnrollment = {
  authority: "synthetic-only",
  branches: [
    {
      branchId: "br-child",
      createdAt: childCreatedAt,
      initSource: "parent-data",
      parentId: "br-root",
      parentLsn: "0/1DE2850",
    },
  ],
  creationApprovalReference: "owned-fresh-project-approval",
  project: { createdAt, id: "synthetic-project", ownerId: "org-owner" },
  root: { branchId: "br-root", createdAt, initSource: "parent-data" },
  sourceBaselineReference: "reviewed-source-baseline",
};
type Operation = "project" | "branch" | "endpoint" | "database" | "role" | "credential";
type ReaderPath = "rest" | "mcp";
interface BranchFixture {
  created_at: string;
  current_state: string;
  default: boolean;
  id: string;
  init_source: string;
  parent_id?: string;
  parent_lsn?: string;
  project_id: string;
}
const fixture = (readerPath: ReaderPath, selected = "br-child", enrolled = true) => {
  const scope: NativePreviewNeonScope = {
    branchId: selected,
    endpointId: "ep-owned",
    hostname: "ep-owned.us-east-1.aws.neon.tech",
    maintenanceDatabase: "neondb",
    maintenanceRole: "bootstrap_owner",
    projectId: "synthetic-project",
  };
  const expectedScope = structuredClone(scope);
  const callerContext = structuredClone(context);
  callerContext.ownerContext = {
    adapterGeneration: 1,
    adapterSessionId: "adapter-session",
    authority: { ...callerContext.authority },
    kind: "direct",
    principal: { ...callerContext.authority, scopes: ["autograph:get"] },
    sessionId: "original-session",
  };
  const ownedEnrollment = structuredClone(enrollment);
  const configuration = {
    connector: "oauth/neon-owned",
    nativeStore: {
      configurationId: "icfg-native",
      resourceId: "store-native",
      sourceProjectId: "prj-source",
    },
    operator: {
      audience: "https://vercel.com/team-owner",
      environment: "preview" as const,
      issuer: "https://oidc.vercel.com/team-owner",
      ownerId: "team-owner",
      projectId: "prj-operator",
    },
    syntheticEnrollment: enrolled ? ownedEnrollment : undefined,
  };
  const project = {
    created_at: createdAt,
    id: scope.projectId,
    owner_id: "org-owner",
  };
  const branches = new Map<string, BranchFixture>([
    [
      "br-root",
      {
        created_at: createdAt,
        current_state: "ready",
        default: true,
        id: "br-root",
        init_source: "parent-data",
        project_id: scope.projectId,
      },
    ],
    [
      "br-child",
      {
        created_at: childCreatedAt,
        current_state: "ready",
        default: false,
        id: "br-child",
        init_source: "parent-data",
        parent_id: "br-root",
        parent_lsn: "0/1DE2850",
        project_id: scope.projectId,
      },
    ],
  ]);
  const branch = (branchId: string) => {
    const value = branches.get(branchId);
    if (value === undefined) {
      throw new Error("Missing fixture branch");
    }
    return value;
  };
  const endpoint = {
    branch_id: selected,
    host: scope.hostname,
    id: scope.endpointId,
    project_id: scope.projectId,
    type: "read_write",
  };
  const calls: Operation[] = [];
  const state = { onRead: (_operation: Operation) => {}, revoked: false };
  const owner = vi.fn<NativePreviewNeonDependencies["readCurrentOwnerNativeStore"]>(async () => {
    if (state.revoked) {
      throw new Error("owner revoked");
    }
    return await Promise.resolve({
      ...configuration.nativeStore,
      neonProjectId: "synthetic-project",
      ownerId: "team-owner",
      vercelProjectId: configuration.nativeStore.sourceProjectId,
    });
  });
  const approved = vi.fn(async () => {});
  const planning = vi.fn(async () => {});
  const consume = vi.fn(
    async (material: {
      maintenanceUrl: string;
      scope: NativePreviewNeonScope;
      initSource: string;
    }) => {
      expect(material.maintenanceUrl).toContain("sslmode=verify-full");
      expect(material.scope).toEqual(expectedScope);
      return material.initSource;
    },
  );
  const sqlIdentity = vi.fn(async () => ({ database: "neondb", role: "bootstrap_owner" }));
  const uri = `postgresql://bootstrap_owner:fixture-private-password@${scope.hostname}/neondb?sslmode=require`;
  const observe = (operation: Operation, branchId = selected) => {
    calls.push(operation);
    state.onRead(operation);
    switch (operation) {
      case "project": {
        return project;
      }
      case "branch": {
        return branches.get(branchId);
      }
      case "endpoint": {
        return endpoint;
      }
      case "database": {
        return { branch_id: selected, name: "neondb" };
      }
      case "role": {
        return { branch_id: selected, name: "bootstrap_owner" };
      }
      case "credential": {
        return { uri };
      }
      default: {
        throw new Error("Unexpected fixture operation");
      }
    }
  };
  const rest = createNativePreviewNeonReader({
    assertApprovedScope: approved,
    configuration: { ...configuration, connectorInstallationId: "neon-owner-installation" },
    fetch: async (input) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const segments = url.pathname.split("/");
      const last = segments.at(-1) ?? "";
      let result;
      if (last === "connection_uri") {
        result = observe("credential");
      } else if (segments.includes("endpoints")) {
        result = { endpoint: observe("endpoint") };
      } else if (segments.includes("databases")) {
        result = { database: observe("database") };
      } else if (segments.includes("roles")) {
        result = { role: observe("role") };
      } else if (segments.includes("branches")) {
        result = { branch: observe("branch", last) };
      } else {
        result = { project: observe("project") };
      }
      return await Promise.resolve(Response.json(result));
    },
    io: {
      getOidc: async () => "fixture-oidc",
      getOwnerToken: async () => "fixture-management-token",
      readSqlIdentity: sqlIdentity,
      verifyOidc: async () => {},
    },
    readCurrentOwnerNativeStore: owner,
  });
  const toolOperations = new Map<string, Operation>(
    Object.entries({
      describe_project: "project",
      get_branch: "branch",
      get_connection_string: "credential",
      get_postgres_database: "database",
      get_postgres_endpoint: "endpoint",
      get_postgres_role: "role",
    }),
  );
  const callTool: NonNullable<PreviewNeonMcpDependencies["io"]>["createClient"] = async () => ({
    callTool: async (input) => {
      const operation = toolOperations.get(input.name);
      if (operation === undefined) {
        throw new Error("Unexpected fixture tool");
      }
      const args = z.record(z.string(), z.string()).parse(input.arguments);
      const observed = observe(operation, args.branch_id);
      const result =
        operation === "credential"
          ? {
              branchId: selected,
              computeId: scope.endpointId,
              databaseName: "neondb",
              projectId: scope.projectId,
              roleName: "bootstrap_owner",
              uri,
            }
          : observed;
      return { content: [{ text: JSON.stringify(result), type: "text" }] };
    },
    close: async () => {},
  });
  const mcp = createPreviewNeonMcpReader({
    assertApprovedScope: approved,
    assertPlanningScope: planning,
    configuration,
    io: {
      createAuthProvider: connectAuthProvider,
      createClient: callTool,
      getOidc: async () => "fixture-oidc",
      readSqlIdentity: sqlIdentity,
      verifyOidc: async () => {},
    },
    readCurrentOwnerNativeStore: owner,
  });
  return {
    approved,
    branches,
    callerContext,
    calls,
    child: branch("br-child"),
    configuration,
    consume,
    endpoint,
    enrollment: ownedEnrollment,
    mcp,
    owner,
    planning,
    project,
    root: branch("br-root"),
    run: async () =>
      await (readerPath === "rest" ? rest : mcp).withMaintenanceCredential(
        callerContext,
        scope,
        consume,
      ),
    scope,
    sqlIdentity,
    state,
  };
};

for (const readerPath of ["rest", "mcp"] as const) {
  describe(`${readerPath} synthetic Neon enrollment`, () => {
    it.each(["br-root", "br-child"])(
      "accepts only the enrolled default root or origin-verified child %s",
      async (selected) => {
        const f = fixture(readerPath, selected);
        await expect(f.run()).resolves.toBe("parent-data");
        expect(f.consume).toHaveBeenCalledOnce();
        expect(f.calls.filter((operation) => operation === "credential")).toHaveLength(1);
      },
    );
    it("preserves legacy schema-only acceptance and denies legacy data-bearing/default branches", async () => {
      const f = fixture(readerPath, "br-child", false);
      await expect(f.run()).rejects.toThrow();
      expect(f.calls).not.toContain("credential");
      f.child.init_source = "parent-schema";
      await expect(f.run()).resolves.toBe("parent-schema");
      f.child.default = true;
      await expect(f.run()).rejects.toThrow();
      expect(f.consume).toHaveBeenCalledOnce();
    });
    it.each([
      ["id", "wrong-project"],
      ["owner_id", "wrong-owner"],
      ["created_at", childCreatedAt],
    ])("rejects wrong project metadata %s before privileged credentials", async (key, value) => {
      const f = fixture(readerPath);
      Reflect.set(f.project, key, value);
      await expect(f.run()).rejects.toThrow();
      expect(f.calls).not.toContain("credential");
      expect(f.sqlIdentity).not.toHaveBeenCalled();
    });
    it.each([
      ["id", "br-other"],
      ["project_id", "wrong-project"],
      ["created_at", childCreatedAt],
      ["default", false],
      ["parent_id", "br-other"],
      ["init_source", "import"],
      ["last_reset_at", createdAt],
      ["restore_status", "finalized"],
      ["restored_from", "snapshot-other"],
      ["restored_as", "br-other"],
      ["current_state", "resetting"],
      ["pending_state", "resetting"],
    ])("rejects changed root %s before privileged credentials", async (key, value) => {
      const f = fixture(readerPath);
      const root = f.branches.get("br-root");
      if (root === undefined) {
        throw new Error("Missing fixture root");
      }
      Reflect.set(root, key, value);
      await expect(f.run()).rejects.toThrow();
      expect(f.calls).not.toContain("credential");
      expect(f.consume).not.toHaveBeenCalled();
    });
    it.each([
      ["default", true],
      ["parent_id", "br-other"],
      ["parent_lsn", "0/OTHER"],
      ["parent_timestamp", createdAt],
      ["init_source", "import"],
      ["created_at", createdAt],
      ["last_reset_at", null],
      ["restore_status", null],
    ])("rejects changed child origin %s before privileged credentials", async (key, value) => {
      const f = fixture(readerPath);
      const child = f.branches.get("br-child");
      if (child === undefined) {
        throw new Error("Missing fixture child");
      }
      Reflect.set(child, key, value);
      await expect(f.run()).rejects.toThrow();
      expect(f.calls).not.toContain("credential");
      expect(f.sqlIdentity).not.toHaveBeenCalled();
    });
    it("does not downgrade to legacy policy for an unlisted schema-only branch", async () => {
      const f = fixture(readerPath);
      if (f.configuration.syntheticEnrollment === undefined) {
        throw new Error("Missing enrollment");
      }
      f.configuration.syntheticEnrollment.branches = [];
      f.child.init_source = "schema-only";
      await expect(f.run()).rejects.toThrow();
      expect(f.calls).not.toContain("credential");
    });
    it.each([
      ["id", "ep-other"],
      ["project_id", "wrong-project"],
      ["branch_id", "br-other"],
      ["host", "ep-other.us-east-1.aws.neon.tech"],
      ["type", "read_only"],
    ])("rejects wrong endpoint %s before privileged credentials", async (key, value) => {
      const f = fixture(readerPath);
      Reflect.set(f.endpoint, key, value);
      await expect(f.run()).rejects.toThrow();
      expect(f.calls).not.toContain("credential");
    });
    it("rejects unknown root readback with an opaque reader error", async () => {
      const f = fixture(readerPath);
      f.branches.delete("br-root");
      await expect(f.run()).rejects.toThrow(
        readerPath === "rest"
          ? /^Protected native Preview credential is unavailable\.$/u
          : /^Protected Preview Neon MCP credential is unavailable\.$/u,
      );
      expect(f.calls).not.toContain("credential");
    });
    it("rereads lineage before URI acquisition and rejects an observed import race", async () => {
      const f = fixture(readerPath);
      f.state.onRead = (operation) => {
        if (operation === "role") {
          f.root.init_source = "import";
        }
      };
      await expect(f.run()).rejects.toThrow();
      expect(f.calls).not.toContain("credential");
    });
    it("rereads endpoint after credential acquisition before opening SQL", async () => {
      const f = fixture(readerPath);
      f.state.onRead = (operation) => {
        if (operation === "credential") {
          f.endpoint.branch_id = "br-other";
        }
      };
      await expect(f.run()).rejects.toThrow();
      expect(f.sqlIdentity).not.toHaveBeenCalled();
      expect(f.consume).not.toHaveBeenCalled();
    });
    it("rereads root after SQL identity before private consumption", async () => {
      const f = fixture(readerPath);
      f.sqlIdentity.mockImplementation(async () => {
        f.root.default = false;
        return { database: "neondb", role: "bootstrap_owner" };
      });
      await expect(f.run()).rejects.toThrow();
      expect(f.consume).not.toHaveBeenCalled();
    });
    it("denies current-owner revocation before credentials and after credentials", async () => {
      for (const revokedAt of ["role", "credential"] as const) {
        const f = fixture(readerPath);
        f.state.onRead = (operation) => {
          if (operation === revokedAt) {
            f.state.revoked = true;
          }
        };
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each revocation case owns independent sequential reader state.
        await expect(f.run()).rejects.toThrow();
        if (revokedAt === "role") {
          expect(f.calls).not.toContain("credential");
        }
        expect(f.sqlIdentity).not.toHaveBeenCalled();
        expect(f.consume).not.toHaveBeenCalled();
      }
    });
    it("snapshots direct owner claims and scopes throughout provider awaits", async () => {
      const f = fixture(readerPath);
      f.state.onRead = (operation) => {
        if (operation === "project") {
          const claims = f.callerContext.ownerContext;
          if (claims === undefined) {
            throw new Error("Missing caller claims");
          }
          claims.authority.ownerUserId = "other-owner";
          claims.principal.ownerUserId = "other-owner";
          claims.principal.scopes.push("unapproved-scope");
        }
      };
      await expect(f.run()).resolves.toBe("parent-data");
      for (const [observed] of f.owner.mock.calls) {
        expect(observed.ownerContext?.authority.ownerUserId).toBe("owner");
        expect(observed.ownerContext?.principal.ownerUserId).toBe("owner");
        expect(observed.ownerContext?.principal.scopes).toEqual(["autograph:get"]);
        expect(Object.isFrozen(observed.ownerContext?.principal.scopes)).toBe(true);
      }
    });
    it("snapshots caller scope and nested deployment enrollment before asynchronous provider reads", async () => {
      const f = fixture(readerPath);
      f.state.onRead = (operation) => {
        if (operation === "project") {
          f.scope.branchId = "br-unapproved";
          f.enrollment.root.branchId = "br-unapproved";
          const [child] = f.enrollment.branches;
          if (child === undefined) {
            throw new Error("Missing enrolled fixture child");
          }
          child.parentId = "br-unapproved";
        }
      };
      await expect(f.run()).resolves.toBe("parent-data");
      expect(f.consume).toHaveBeenCalledOnce();
    });
  });
}

describe("MCP enrolled planning boundary", () => {
  it("accepts enrolled origin metadata without an approved effect, SQL identity or URI", async () => {
    const f = fixture("mcp");
    await expect(f.mcp.inspectPlanningTarget(context, f.scope)).resolves.toEqual({
      initSource: "parent-data",
      scope: f.scope,
    });
    expect(f.planning).toHaveBeenCalled();
    expect(f.approved).not.toHaveBeenCalled();
    expect(f.calls).not.toContain("credential");
    expect(f.sqlIdentity).not.toHaveBeenCalled();
  });
  it("rejects a root change during planning before returning any authority", async () => {
    const f = fixture("mcp");
    f.state.onRead = (operation) => {
      if (operation === "role") {
        Reflect.set(f.root, "restore_status", "restored");
      }
    };
    await expect(f.mcp.inspectPlanningTarget(context, f.scope)).rejects.toThrow();
    expect(f.calls).not.toContain("credential");
    expect(f.sqlIdentity).not.toHaveBeenCalled();
  });
});

// The shared configuration importer must retain enrollment without a second adapter.
describe("native Neon deployment configuration", () => {
  it("preserves enrollment through the existing source configuration schema", () => {
    const f = fixture("mcp");
    const parsed = hostedOperatorSourceConfigurationSchema.shape.nativeNeon.parse({
      configuration: f.configuration,
      scope: f.scope,
    });
    expect(parsed.configuration.syntheticEnrollment).toEqual(enrollment);
  });
});
