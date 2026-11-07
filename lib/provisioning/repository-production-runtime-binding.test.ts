/* oxlint-disable eslint/require-await, unicorn/no-await-expression-member -- Async fixture ports retain rejection semantics; assertions inspect their awaited outcomes directly. */
import { z } from "zod";
import { describe, expect, it } from "vitest";
import { createRepositoryProductionRuntimeBinding } from "./repository-production-runtime-binding";
import {
  initialRepositoryProductionRecord,
  repositoryProductionOperationRef,
} from "./repository-production-contract";
import type { RepositoryProductionScope } from "./repository-production-contract";
import type { RepositoryProductionEffectContext } from "./repository-production-setup";

const scope: RepositoryProductionScope = {
  appId: "requests",
  authority: {
    audience: "https://builder.test/mcp",
    issuer: "https://builder.test/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  environment: "production",
  organizationId: "org",
  projectId: "app-project",
  publicOrigin: "https://apps.test",
  repositoryFullName: "example/repo",
  repositoryId: "repo",
};
const runtimeUrl = "postgresql://app_role:private@ep-test.neon.tech/app_db?sslmode=verify-full";
const fixture = () => {
  const record = initialRepositoryProductionRecord(scope, {
    creatorRoles: ["user"],
    sessionId: "session",
    sourceSha: "a".repeat(40),
    storage: {
      artifactRef: "artifact",
      databaseEnvironment: "REQUESTS_DATABASE_URL",
      kind: "postgres",
      manifestSha256: "b".repeat(64),
      releaseId: "release",
    },
  });
  const context: RepositoryProductionEffectContext = {
    assertCurrent: async () => {},
    checkpoint: async (value) => {
      record.workerCheckpoints.push(value);
    },
    effect: "bind-runtime",
    row: { operationRef: repositoryProductionOperationRef(scope), record, revision: 1 },
  };
  let row: Record<string, string | string[]> | undefined;
  let loseResponse = false;
  let writes = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.searchParams.get("teamId")).toBe("team");
    expect(url.pathname).toContain("/projects/app-project/env");
    if (init?.method === "POST") {
      writes += 1;
      const body = z.string().parse(init.body);
      row = {
        id: "env-id",
        ...z.record(z.string(), z.union([z.string(), z.array(z.string())])).parse(JSON.parse(body)),
      };
      if (loseResponse) {
        throw new Error("response lost");
      }
      return Response.json({ created: row });
    }
    return Response.json(url.pathname.endsWith("/env-id") ? row : { envs: row ? [row] : [] });
  };
  return {
    context,
    loseResponse: () => {
      loseResponse = true;
    },
    replaceRow: (value?: Record<string, string | string[]>) => {
      row = value;
    },
    row: () => row,
    service: createRepositoryProductionRuntimeBinding({
      fetch: fetcher,
      readCredential: async () => "provider-token",
      signal: new AbortController().signal,
      teamId: "team",
    }),
    writes: () => writes,
  };
};
describe("Production runtime credential binding", () => {
  it("binds only the app's encrypted Production variable and reuses it", async () => {
    const f = fixture();
    await f.service.apply(f.context, runtimeUrl);
    expect((await f.service.reconcile(f.context, runtimeUrl)).state).toBe("applied");
    await f.service.apply(f.context, runtimeUrl);
    expect(f.writes()).toBe(1);
    expect(f.row()).toMatchObject({
      key: "REQUESTS_DATABASE_URL",
      target: ["production"],
      type: "encrypted",
    });
  });
  it("reconciles a lost creation response from owned provider readback without duplicate writes", async () => {
    const f = fixture();
    f.loseResponse();
    await expect(f.service.apply(f.context, runtimeUrl)).rejects.toThrow("response lost");
    expect((await f.service.reconcile(f.context, runtimeUrl)).state).toBe("applied");
    await f.service.apply(f.context, runtimeUrl);
    expect(f.writes()).toBe(1);
  });
  it("never adopts or overwrites an existing unrelated secret", async () => {
    const f = fixture();
    f.replaceRow({
      id: "foreign",
      key: "REQUESTS_DATABASE_URL",
      target: ["production"],
      type: "encrypted",
      value: "foreign",
    });
    await expect(f.service.apply(f.context, runtimeUrl)).rejects.toThrow("binding_conflict");
    expect(f.writes()).toBe(0);
  });
  it("keeps an unobserved creation uncertain when the provider does not return the row", async () => {
    const f = fixture();
    f.loseResponse();
    await expect(f.service.apply(f.context, runtimeUrl)).rejects.toThrow();
    f.replaceRow();
    expect((await f.service.reconcile(f.context, runtimeUrl)).state).toBe("unknown");
    await expect(f.service.apply(f.context, runtimeUrl)).rejects.toThrow("reconciliation_required");
    expect(f.writes()).toBe(1);
  });
});
