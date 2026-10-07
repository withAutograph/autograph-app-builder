/* oxlint-disable eslint/require-await, sonarjs/no-hardcoded-passwords -- Synthetic tenant and provider fixtures. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { cleanupHostedRuntime } from "./hosted-runtime-cleanup";
import { hostedRuntimeIdentity } from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalRow,
  HostedRuntimeJournalStore,
  HostedRuntimeTarget,
} from "./hosted-runtime-journal";
import {
  encryptHostedRuntimeFiles,
  HostedRuntimeCommandError,
  hostedRuntimeBindings,
} from "./hosted-runtime-service";
import type { HostedRuntimeExecutor } from "./hosted-runtime-service";
import type { VercelIntegrationConfig } from "../integrations/vercel-installation";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const target: HostedRuntimeTarget = {
  appId: "spend-review",
  branch: "builder/owned",
  environment: "preview",
  installationId: "icfg_owner",
  projectId: "prj_owner",
  scopeId: "team_owner",
  scopeType: "team",
  sessionId: "session_owner",
};
const config: VercelIntegrationConfig = {
  clientId: "client",
  clientSecret: "synthetic",
  issuer: authority.issuer,
  resource: authority.audience,
  slug: "builder",
  tokenKey: Buffer.alloc(32, 9),
  tokenKeyVersion: "synthetic",
};
const clusterUrl = "postgresql://installer:synthetic@ep-owner.neon.tech/neondb?sslmode=verify-full";
const files = {
  "environment.json": JSON.stringify({
    BETTER_AUTH_APP_NAME: "apps",
    BETTER_AUTH_SECRET: "synthetic-runtime-secret",
    BETTER_AUTH_URL: "https://owned.vercel.run",
    PLATFORM_AUTH_DATABASE_URL:
      "postgresql://runtime_owned_auth:synthetic-auth@ep-owner.neon.tech/auth_owned?sslmode=verify-full",
    SPEND_REVIEW_DATABASE_URL:
      "postgresql://runtime_owned:synthetic-app@ep-owner.neon.tech/app_owned?sslmode=verify-full",
  }),
  "state.json": JSON.stringify({
    clusterUrl,
    plan: {
      appId: target.appId,
      authDatabase: "auth_owned",
      database: "app_owned",
      principal: "runtime_owned",
    },
  }),
};
const fixture = () => {
  let row: HostedRuntimeJournalRow = {
    record: {
      approvedByCallId: "prepare_approved",
      kind: "app-runtime",
      privateState: encryptHostedRuntimeFiles({ authority, config, files, target }),
      request: target,
      status: "prepared",
      step: "bound",
      version: 1,
    },
    revision: 1,
  };
  const store: HostedRuntimeJournalStore = {
    compareAndSet: async (input) => {
      if (input.expectedRevision !== row.revision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS conflict must remain explicit.
        return undefined;
      }
      row = { record: structuredClone(input.record), revision: row.revision + 1 };
      return structuredClone(row);
    },
    read: async () => structuredClone(row),
    reserve: async () => structuredClone(row),
    reserveFenceGeneration: async () => {},
  };
  const { runtimeId } = hostedRuntimeIdentity(authority, target);
  const environment = z
    .array(
      z.object({
        comment: z.string(),
        configurationId: z.string(),
        gitBranch: z.string(),
        id: z.string(),
        key: z.string(),
        target: z.array(z.string()),
        value: z.string(),
      }),
    )
    .parse([
      {
        comment: "Neon native",
        configurationId: "icfg_neon",
        gitBranch: target.branch,
        id: "native",
        key: "DATABASE_URL_UNPOOLED",
        target: ["preview"],
        value: clusterUrl,
      },
      {
        comment: "Selected guard",
        configurationId: "",
        gitBranch: target.branch,
        id: "guard",
        key: "AUTH_PRODUCTION_DATABASE_IDENTITY",
        target: ["preview"],
        value: "ep-production.neon.tech/neondb",
      },
      ...Object.entries(hostedRuntimeBindings(files, target.appId))
        .filter(([key]) => key !== "BETTER_AUTH_URL")
        .map(([key, value]) => ({
          comment: `App Builder runtime ${runtimeId}`,
          configurationId: "",
          gitBranch: target.branch,
          id: `owned_${key}`,
          key,
          target: ["preview"],
          value,
        })),
    ]);
  const failure = { environmentId: "" };
  const request = vi.fn<typeof fetch>(async (resource, init) => {
    const url = new URL(resource instanceof Request ? resource.url : resource.toString());
    if (init?.method === "DELETE") {
      const id = url.pathname.split("/").at(-1);
      if (id === failure.environmentId) {
        return new Response(null, { status: 503 });
      }
      const index = environment.findIndex((entry) => entry.id === id);
      if (index !== -1) {
        environment.splice(index, 1);
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/env")) {
      return Response.json({ envs: environment });
    }
    const id = url.pathname.split("/").at(-1);
    return Response.json(
      environment.find((entry) => entry.id === id) ?? {
        accountId: target.scopeId,
        framework: "services",
        id: target.projectId,
        rootDirectory: ".",
      },
    );
  });
  const credential = {
    binding: {
      active: true,
      displayName: "Owner",
      installationId: target.installationId,
      plan: "pro",
      scopeId: target.scopeId,
      scopeType: target.scopeType,
      slug: "owner",
      updatedAt: new Date(),
    },
    token: "synthetic-owner-token",
  };
  const restore = vi.fn<HostedRuntimeExecutor["restore"]>();
  const run = vi.fn<HostedRuntimeExecutor["run"]>().mockImplementation(async ({ operation }) => {
    expect(operation).toBe("cleanup");
    expect(
      environment.filter((entry) => entry.comment.startsWith("App Builder runtime")),
    ).toHaveLength(0);
    return null;
  });
  const input = {
    approvedByCallId: "cleanup_approved",
    authority,
    config,
    executor: { capture: async () => files, restore, run },
    fetch: request,
    readCredential: vi.fn(async () => credential),
    store,
    target,
  };
  return { environment, failure, input, read: () => row, request, restore, run };
};

describe("approved hosted runtime cleanup", () => {
  it("removes owned branch bindings before deleting databases, clears ciphertext, and is idempotent", async () => {
    const f = fixture();
    expect(await cleanupHostedRuntime(f.input)).toMatchObject({ status: "cleaned" });
    expect(f.restore).toHaveBeenCalledWith(files);
    expect(f.read().record).toMatchObject({
      cleanupApprovedByCallId: "cleanup_approved",
      status: "cleaned",
      step: "cleaned",
    });
    expect(f.read().record.privateState).toBeUndefined();
    expect(f.read().record.leaseId).toBeUndefined();
    expect(f.environment.map((entry) => entry.id)).toEqual(["native", "guard"]);
    expect(await cleanupHostedRuntime(f.input)).toMatchObject({ status: "cleaned" });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("resumes resource cleanup after database failure without deleting native variables", async () => {
    const f = fixture();
    f.run.mockRejectedValueOnce(new HostedRuntimeCommandError("cleanup", 7));
    expect(await cleanupHostedRuntime(f.input)).toMatchObject({
      exitCode: 7,
      operation: "cleanup",
      status: "failed",
    });
    expect(f.read().record).toMatchObject({ status: "failed", step: "environment-removed" });
    expect(f.read().record.privateState).toBeDefined();
    expect(await cleanupHostedRuntime(f.input)).toMatchObject({ status: "cleaned" });
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it("retains recovery state and avoids DB cleanup when one provider deletion fails", async () => {
    const f = fixture();
    f.failure.environmentId = "owned_BETTER_AUTH_SECRET";
    expect(await cleanupHostedRuntime(f.input)).toMatchObject({
      code: "provider_unavailable",
      status: "blocked",
    });
    expect(f.run).not.toHaveBeenCalled();
    expect(f.read().record.privateState).toBeDefined();
    f.failure.environmentId = "";
    expect(await cleanupHostedRuntime(f.input)).toMatchObject({ status: "cleaned" });
    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("preserves changed or unowned branch variables and all DB resources", async () => {
    const f = fixture();
    const changed = f.environment.find((entry) => entry.id === "owned_SPEND_REVIEW_DATABASE_URL");
    if (changed === undefined) {
      throw new Error("Owned binding fixture is missing");
    }
    changed.comment = "another runtime";
    expect(await cleanupHostedRuntime(f.input)).toMatchObject({
      code: "resource_mismatch",
      status: "blocked",
    });
    expect(f.request.mock.calls.filter(([, options]) => options?.method === "DELETE")).toHaveLength(
      0,
    );
    expect(f.run).not.toHaveBeenCalled();
  });

  it("blocks revoked owner access before provider or database effects", async () => {
    const f = fixture();
    f.input.readCredential.mockRejectedValue(new Error("workspace membership revoked"));
    expect(await cleanupHostedRuntime(f.input)).toMatchObject({ status: "failed" });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.read().record.privateState).toBeDefined();
  });

  it("leaves another active preparation lease untouched", async () => {
    const f = fixture();
    f.read().record.leaseId = "b5d6a207-17c2-42f5-85e2-5b12fb2d5b80";
    f.read().record.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    expect(await cleanupHostedRuntime(f.input)).toMatchObject({ status: "pending" });
    expect(f.request).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });

  it("cleans a never-bound losing preparation while preserving the winning runtime's shared Auth", async () => {
    const f = fixture();
    f.read().record.status = "failed";
    f.read().record.step = "verified";
    f.read().record.environmentBound = false;
    for (const entry of f.environment) {
      if (
        entry.key === "PLATFORM_AUTH_DATABASE_URL" ||
        entry.key === "BETTER_AUTH_SECRET" ||
        entry.key === "BETTER_AUTH_APP_NAME"
      ) {
        entry.comment = "App Builder runtime another_runtime";
      }
    }
    f.run.mockImplementation(async () => null);
    expect(await cleanupHostedRuntime(f.input)).toMatchObject({ status: "cleaned" });
    expect(f.run).toHaveBeenCalledTimes(1);
    expect(
      f.environment.filter((entry) => entry.comment === "App Builder runtime another_runtime"),
    ).toHaveLength(3);
    expect(f.environment.some((entry) => entry.key === "SPEND_REVIEW_DATABASE_URL")).toBe(false);
  });
});
