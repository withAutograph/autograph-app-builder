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
  authority: {
    issuer: "https://builder.test/api/auth",
    audience: "https://builder.test/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  appId: "requests",
  repositoryId: "repo",
  repositoryFullName: "example/repo",
  projectId: "app-project",
  organizationId: "org",
  publicOrigin: "https://apps.test",
  environment: "production",
};
const runtimeUrl = "postgresql://app_role:private@ep-test.neon.tech/app_db?sslmode=verify-full";
const fixture = () => {
  const record = initialRepositoryProductionRecord(scope, {
    sessionId: "session",
    sourceSha: "a".repeat(40),
    creatorRoles: ["user"],
    storage: {
      kind: "postgres",
      artifactRef: "artifact",
      releaseId: "release",
      manifestSha256: "b".repeat(64),
      databaseEnvironment: "REQUESTS_DATABASE_URL",
    },
  });
  const context: RepositoryProductionEffectContext = {
    row: { operationRef: repositoryProductionOperationRef(scope), revision: 1, record },
    effect: "bind-runtime",
    assertCurrent: async () => {},
    checkpoint: async (value) => {
      record.workerCheckpoints.push(value);
    },
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
    writes: () => writes,
    row: () => row,
    loseResponse: () => {
      loseResponse = true;
    },
    replaceRow: (value?: Record<string, string | string[]>) => {
      row = value;
    },
    service: createRepositoryProductionRuntimeBinding({
      teamId: "team",
      signal: new AbortController().signal,
      readCredential: async () => "provider-token",
      fetch: fetcher,
    }),
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
      type: "encrypted",
      target: ["production"],
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
