/* oxlint-disable eslint/require-await, unicorn/no-await-expression-member -- Async fixture ports retain rejection semantics; assertions inspect their awaited outcomes directly. */
import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  let detail: unknown;
  let httpFailure: { phase: "list" | "detail" | "write"; status: number } | undefined;
  let rejection: Error | undefined;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.searchParams.get("teamId")).toBe("team");
    expect(url.pathname).toContain("/projects/app-project/env");
    const readPhase = url.pathname.endsWith("/env-id") ? "detail" : "list";
    const phase = init?.method === "POST" ? "write" : readPhase;
    if (rejection !== undefined) {
      throw rejection;
    }
    if (httpFailure?.phase === phase) {
      return new Response("private-response-body", { status: httpFailure.status });
    }
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
    return Response.json(
      url.pathname.endsWith("/env-id") ? (detail ?? row) : { envs: row ? [row] : [] },
    );
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
    detail: (value: unknown) => {
      detail = value;
    },
    failHttp: (phase: "list" | "detail" | "write", status: number) => {
      httpFailure = { phase, status };
    },
    reject: (value: Error) => {
      rejection = value;
    },
    service: createRepositoryProductionRuntimeBinding({
      teamId: "team",
      signal: new AbortController().signal,
      readCredential: async () => "provider-token",
      fetch: fetcher,
    }),
    writes: () => writes,
  };
};
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("Production runtime credential binding", () => {
  it.each(["dispatch", "owner", "recorded-row", "environment"] as const)(
    "requires retained list ownership and %s proof before accepting a minimal detail",
    async (variation) => {
      const f = fixture();
      await f.service.apply(f.context, runtimeUrl);
      const row = f.row();
      if (variation === "dispatch") {
        f.context.row.record.workerCheckpoints = [];
      }
      if (variation === "owner") {
        f.replaceRow({ ...row, comment: "foreign-owner" });
      }
      if (variation === "recorded-row") {
        f.context.row.record.workerCheckpoints.push({
          ...z.record(z.string(), z.json()).parse(f.context.row.record.workerCheckpoints[0]),
          rowId: "foreign-row",
        });
      }
      if (variation === "environment") {
        f.replaceRow({ ...row, target: ["production", "preview"] });
      }
      f.detail({
        key: "REQUESTS_DATABASE_URL",
        type: "encrypted",
        value: runtimeUrl,
        decrypted: true,
      });
      await expect(f.service.reconcile(f.context, runtimeUrl)).rejects.toThrow("binding_conflict");
      expect(f.writes()).toBe(1);
    },
  );
  it.each([undefined, "production", ["production"]])(
    "accepts documented decrypted detail with optional metadata and target %s",
    async (target) => {
      const f = fixture();
      await f.service.apply(f.context, runtimeUrl);
      f.detail({
        key: "REQUESTS_DATABASE_URL",
        type: "encrypted",
        value: runtimeUrl,
        decrypted: true,
        ...(target === undefined ? {} : { target }),
      });
      expect((await f.service.reconcile(f.context, runtimeUrl)).state).toBe("applied");
      await f.service.apply(f.context, runtimeUrl);
      expect(f.writes()).toBe(1);
    },
  );
  it.each([
    { id: "foreign-id" },
    { key: "OTHER_DATABASE_URL" },
    { type: "plain" },
    { comment: "foreign-owner" },
    { target: "preview" },
    { target: ["production", "preview"] },
    { target: [] },
    { target: ["production", "production"] },
    { gitBranch: "feature" },
    { configurationId: "foreign-configuration" },
    { customEnvironmentIds: ["foreign-environment"] },
  ])("rejects contradictory detail metadata %j without another write", async (patch) => {
    const f = fixture();
    await f.service.apply(f.context, runtimeUrl);
    f.detail({ ...f.row(), ...patch });
    await expect(f.service.reconcile(f.context, runtimeUrl)).rejects.toThrow("binding_conflict");
    expect(f.writes()).toBe(1);
    expect(vi.mocked(console.warn).mock.calls.flat().join("")).toContain(
      '"phase":"runtime_binding_ownership"',
    );
  });
  it.each([
    { decrypted: false },
    { value: undefined },
    { value: runtimeUrl.replace("app_role", "wrong_role") },
  ])("requires an available exact runtime value %j", async (patch) => {
    const f = fixture();
    await f.service.apply(f.context, runtimeUrl);
    f.detail({ ...f.row(), ...patch });
    await expect(f.service.reconcile(f.context, runtimeUrl)).rejects.toThrow();
    expect(f.writes()).toBe(1);
    const output = vi.mocked(console.warn).mock.calls.flat().join("");
    expect(output).not.toContain(runtimeUrl);
    expect(output).not.toContain("private");
    expect(output).not.toContain("wrong_role");
  });
  it.each(["list", "detail", "write"] as const)(
    "reports a closed %s HTTP failure without provider content",
    async (phase) => {
      const f = fixture();
      if (phase === "detail") {
        await f.service.apply(f.context, runtimeUrl);
      }
      f.failHttp(phase, 403);
      await expect(f.service.apply(f.context, runtimeUrl)).rejects.toThrow(
        "runtime_provider_failed",
      );
      const output = vi.mocked(console.warn).mock.calls.flat().join("");
      expect(output).toContain(`"phase":"runtime_binding_${phase}"`);
      expect(output).toContain('"httpStatus":403');
      for (const secret of [
        runtimeUrl,
        "private-response-body",
        "provider-token",
        "api.vercel.com",
        "app-project",
      ]) {
        expect(output).not.toContain(secret);
      }
    },
  );
  it("reports detail grammar and hash failures separately without raw validation issues", async () => {
    const f = fixture();
    await f.service.apply(f.context, runtimeUrl);
    f.detail({
      key: "REQUESTS_DATABASE_URL",
      type: "encrypted",
      value: { secret: "private-zod-input" },
    });
    await expect(f.service.reconcile(f.context, runtimeUrl)).rejects.toThrow();
    let output = vi.mocked(console.warn).mock.calls.flat().join("");
    expect(output).toContain('"phase":"runtime_binding_detail"');
    expect(output).toContain('"reason":"schema_invalid"');
    expect(output).not.toContain("private-zod-input");
    vi.mocked(console.warn).mockClear();
    f.detail({ key: "REQUESTS_DATABASE_URL", type: "encrypted", value: "wrong-value" });
    await expect(f.service.reconcile(f.context, runtimeUrl)).rejects.toThrow("binding_conflict");
    output = vi.mocked(console.warn).mock.calls.flat().join("");
    expect(output).toContain('"phase":"runtime_binding_value"');
    expect(output).toContain('"reason":"runtime_binding_conflict"');
    expect(output).not.toContain("wrong-value");
  });
  it("preserves original request failures when diagnostic access or logging fails", async () => {
    const f = fixture();
    const read = vi.fn(() => {
      throw new Error("private-accessor");
    });
    const failure = Object.defineProperties(new Error("private-failure"), {
      status: { get: read },
      cause: { get: read },
      code: { get: read },
    });
    f.reject(failure);
    vi.mocked(console.warn).mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    await expect(f.service.reconcile(f.context, runtimeUrl)).rejects.toBe(failure);
    expect(read).not.toHaveBeenCalled();
  });
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
