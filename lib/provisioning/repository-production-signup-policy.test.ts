/* oxlint-disable eslint/require-await -- Async worker fakes retain the real policy read/write and lost-response contract. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  initialRepositoryProductionRecord,
  repositoryProductionDigest,
  repositoryProductionOperationRef,
  repositoryProductionRecordSchema,
} from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
} from "./repository-production-contract";
import { repositoryProductionApprovalDigest } from "./repository-production-approval";
import {
  createRepositoryProductionSignupPolicy,
  resolveRepositoryProductionSignupIntent,
  sameRepositoryProductionIntent,
} from "./repository-production-signup-policy";
import type { RepositoryProductionSignupPolicy } from "./repository-production-signup-policy";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";
import type { AppDescription } from "../repository/app-description";

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId: "requests",
  repositoryId: "repo",
  repositoryFullName: "example/apps",
  projectId: "project",
  organizationId: "org",
  publicOrigin: "https://apps.test",
  environment: "production",
};
const intent: RepositoryProductionIntent = {
  sessionId: "session",
  sourceSha: "a".repeat(40),
  creatorRoles: [],
  storage: { kind: "none" },
};
const publicIntent: RepositoryProductionIntent = {
  ...intent,
  access: { mode: "self-signup", eligibility: "public", appRoles: [] },
  entryPath: "/requests",
};
const description: AppDescription = {
  version: 1,
  app: { id: "requests", routes: ["/requests"], workspacePath: "apps/requests" },
  backend: { kind: "static" },
  validation: { browser: null, check: { task: "check" }, test: null },
};
const fixture = () => {
  let policy: RepositoryProductionSignupPolicy | undefined;
  let lost = false;
  const context: RepositoryProductionEffectContext = {
    row: {
      operationRef: repositoryProductionOperationRef(scope),
      revision: 1,
      record: initialRepositoryProductionRecord(scope, publicIntent),
    },
    effect: "signup-policy",
    assertCurrent: async () => {},
    checkpoint: async () => {},
  };
  const request = vi.fn(
    async (
      _context: RepositoryProductionEffectContext,
      value: z.infer<ReturnType<typeof z.json>>,
      readOnly: boolean,
    ) => {
      const operation = z.object({ action: z.string() }).parse(value);
      if (operation.action === "read-signup-policy") {
        expect(readOnly).toBe(true);
        return policy ?? null;
      }
      expect(readOnly).toBe(false);
      if (operation.action === "set-signup-policy") {
        const selected = z
          .object({
            policy: z.object({
              policyId: z.uuid(),
              appPath: z.string(),
              eligibility: z.enum(["public", "approved-email"]),
              allowedEmails: z.array(z.email()).optional(),
              appRoles: z.array(z.string()),
              storage: z.enum(["none", "postgres"]),
            }),
          })
          .parse(value).policy;
        policy = {
          ...selected,
          version: 1,
          policyDigest: "b".repeat(64),
          workspaceId: "workspace",
          resourceDigest: "c".repeat(64),
          appId: "requests",
          organizationId: "org",
          origin: "https://apps.test",
          enabled: true,
          operationRef: context.row.operationRef,
          planDigest: "d".repeat(64),
          fenceGeneration: 1,
        };
      } else if (policy) {
        policy.enabled = false;
      }
      if (lost) {
        lost = false;
        throw new Error("lost response");
      }
      return policy ?? null;
    },
  );
  return {
    service: createRepositoryProductionSignupPolicy({ request }),
    context,
    request,
    policy: () => policy,
    loseResponse: () => {
      lost = true;
    },
  };
};

describe("Production signup policy", () => {
  it("keeps absent and explicit private approvals compatible with the legacy digest", () => {
    const legacy = repositoryProductionDigest({
      scope,
      creatorRoles: [],
      storage: { kind: "none" },
    });
    expect(repositoryProductionApprovalDigest(scope, intent)).toBe(legacy);
    expect(
      repositoryProductionApprovalDigest(scope, { ...intent, access: { mode: "private" } }),
    ).toBe(legacy);
    expect(sameRepositoryProductionIntent(intent, { ...intent, access: { mode: "private" } })).toBe(
      true,
    );
    const effects = z
      .object({
        "allocate-storage": z.json(),
        "install-schema": z.json(),
        "creator-access": z.json(),
        "bind-runtime": z.json(),
      })
      .parse(initialRepositoryProductionRecord(scope, intent).effects);
    expect(
      repositoryProductionRecordSchema.parse({
        ...initialRepositoryProductionRecord(scope, intent),
        effects,
      }).effects["signup-policy"],
    ).toEqual({ state: "idle" });
  });
  it("preserves a saved same-app policy when a new session omits access, and honors explicit disablement", () => {
    expect(resolveRepositoryProductionSignupIntent({}, description, publicIntent.access)).toEqual({
      access: publicIntent.access,
      entryPath: "/requests",
    });
    expect(
      resolveRepositoryProductionSignupIntent(
        { access: { mode: "private" } },
        description,
        publicIntent.access,
      ),
    ).toEqual({ access: { mode: "private" } });
    expect(resolveRepositoryProductionSignupIntent({}, description)).toEqual({});
  });
  it("canonicalizes set ordering, email case, and public empty lists for approval and revision identity", () => {
    const first: RepositoryProductionIntent = {
      ...intent,
      access: {
        mode: "self-signup",
        eligibility: "approved-email",
        appRoles: ["b", "a"],
        allowedEmails: ["B@example.test", "a@example.test"],
      },
    };
    const second: RepositoryProductionIntent = {
      ...intent,
      access: {
        mode: "self-signup",
        eligibility: "approved-email",
        appRoles: ["a", "b"],
        allowedEmails: ["a@example.test", "b@example.test"],
      },
    };
    expect(repositoryProductionApprovalDigest(scope, first)).toBe(
      repositoryProductionApprovalDigest(scope, second),
    );
    expect(sameRepositoryProductionIntent(first, second)).toBe(true);
    const emptyPublic: RepositoryProductionIntent = {
      ...publicIntent,
      access: { mode: "self-signup", eligibility: "public", appRoles: [], allowedEmails: [] },
    };
    expect(repositoryProductionApprovalDigest(scope, emptyPublic)).toBe(
      repositoryProductionApprovalDigest(scope, publicIntent),
    );
    expect(sameRepositoryProductionIntent(emptyPublic, publicIntent)).toBe(true);
  });
  it("binds public eligibility, role choices and the trusted return path into approval", () => {
    const approved = repositoryProductionApprovalDigest(scope, publicIntent);
    expect(approved).not.toBe(repositoryProductionApprovalDigest(scope, intent));
    expect(
      repositoryProductionApprovalDigest(scope, {
        ...publicIntent,
        access: {
          mode: "self-signup",
          eligibility: "approved-email",
          allowedEmails: ["member@example.test"],
          appRoles: [],
        },
      }),
    ).not.toBe(approved);
    expect(
      repositoryProductionApprovalDigest(scope, { ...publicIntent, entryPath: "/other" }),
    ).not.toBe(approved);
    expect(
      repositoryProductionApprovalDigest(scope, {
        ...publicIntent,
        access: { mode: "self-signup", eligibility: "public", appRoles: ["admin"] },
      }),
    ).not.toBe(approved);
  });
  it("derives signup only from structured intent and the captured role catalog", () => {
    expect(
      resolveRepositoryProductionSignupIntent({ narrative: "public signup" }, description),
    ).toEqual({});
    expect(
      resolveRepositoryProductionSignupIntent({ access: publicIntent.access }, description),
    ).toEqual({ access: publicIntent.access, entryPath: "/requests" });
    expect(() =>
      resolveRepositoryProductionSignupIntent(
        { access: { mode: "self-signup", eligibility: "public", appRoles: ["admin"] } },
        description,
      ),
    ).toThrow("roles_unavailable");
  });
  it("accepts an explicitly approved source-owned domain role and rejects foreign roles", () => {
    const generated: AppDescription = {
      ...description,
      backend: {
        kind: "generated-postgres",
        authorization: "declared-policy",
        roles: ["asset_owner"],
        release: { id: "release", directory: "release", artifactHash: "a".repeat(64) },
        runtime: { databaseEnvironment: "REQUESTS_DATABASE_URL" },
        schemaReceipt: null,
      },
    };
    const access = {
      mode: "self-signup" as const,
      eligibility: "public" as const,
      appRoles: ["asset_owner"],
    };
    expect(resolveRepositoryProductionSignupIntent({ access }, generated)).toEqual({
      access,
      entryPath: "/requests",
    });
    expect(() =>
      resolveRepositoryProductionSignupIntent(
        { access: { ...access, appRoles: ["unrelated_role"] } },
        generated,
      ),
    ).toThrow("roles_unavailable");
    expect(() =>
      resolveRepositoryProductionSignupIntent({ access: { ...access, appRoles: [] } }, generated),
    ).toThrow("roles_unavailable");
    if (generated.backend.kind !== "generated-postgres") {
      throw new Error("Expected a generated PostgreSQL app");
    }
    expect(
      resolveRepositoryProductionSignupIntent(
        { access: { ...access, appRoles: [] } },
        { ...generated, backend: { ...generated.backend, roles: [] } },
      ),
    ).toEqual({ access: { ...access, appRoles: [] }, entryPath: "/requests" });
    expect(
      resolveRepositoryProductionSignupIntent(
        { access },
        { ...generated, app: { ...generated.app, routes: ["/requests?tab=open"] } },
      ).entryPath,
    ).toBe("/requests?tab=open");
  });
  it("reads back an installed policy after a lost response and disables only that policy", async () => {
    const test = fixture();
    await expect(test.service.reconcile(test.context)).resolves.toEqual({ state: "not-applied" });
    test.loseResponse();
    await expect(test.service.apply(test.context)).rejects.toThrow("lost response");
    await expect(test.service.reconcile(test.context)).resolves.toMatchObject({
      state: "applied",
      receipt: { enabled: true, appPath: "/requests", storage: "none" },
    });
    test.context.row.record.intent = { ...intent, access: { mode: "private" } };
    await test.service.apply(test.context);
    await expect(test.service.reconcile(test.context)).resolves.toMatchObject({
      state: "applied",
      receipt: { enabled: false },
    });
    expect(
      test.request.mock.calls.map(
        ([, value]) => z.object({ action: z.string() }).parse(value).action,
      ),
    ).toEqual([
      "read-signup-policy",
      "set-signup-policy",
      "read-signup-policy",
      "read-signup-policy",
      "disable-signup-policy",
      "read-signup-policy",
    ]);
  });
});
