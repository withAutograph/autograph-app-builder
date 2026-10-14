import { describe, expect, it, vi } from "vitest";
import { readVercelNativeNeonBinding } from "./hosted-runtime-native-neon-binding";
import type {
  MarketplaceJsonValue,
  MarketplaceResourceErrorCode,
} from "./hosted-runtime-marketplace-resource";

const input = {
  sourceProjectId: "prj_source",
  configurationId: "icfg_neon",
  resourceId: "store_neon",
  neonProjectId: "synthetic-project",
};
const row = {
  id: "env_identity",
  key: "AUTOGRAPH_PREVIEW_SOURCE_NEON_PROJECT_ID",
  configurationId: null,
  contentHint: {
    type: "integration-store-secret",
    storeId: input.resourceId,
    integrationConfigurationId: input.configurationId,
    integrationId: "oac_neon",
    integrationProductId: "iap_neon",
  },
  target: ["preview"],
};
const identityDetail = { ...row, value: input.neonProjectId };
const fail = (code: MarketplaceResourceErrorCode) => Object.assign(new Error(code), { code });
const fixture = (
  rows: MarketplaceJsonValue[] = [row],
  detail: MarketplaceJsonValue = identityDetail,
) => {
  const request = vi.fn(async (path: string): Promise<MarketplaceJsonValue> => {
    await Promise.resolve();
    if (path === `/v9/projects/${input.sourceProjectId}/env`) {
      return { envs: rows };
    }
    expect(path).toBe(`/v1/projects/${input.sourceProjectId}/env/${row.id}`);
    return detail;
  });
  return {
    request,
    read: async () => await readVercelNativeNeonBinding({ ...input, request, fail }),
  };
};

describe("native Neon binding through provider-maintained project metadata", () => {
  it("reads only the exact nonsecret identity row and ignores credential rows", async () => {
    const f = fixture([
      { ...row, id: "env_password", key: "AUTOGRAPH_PREVIEW_SOURCE_POSTGRES_PASSWORD" },
      { ...row, id: "env_url", key: "AUTOGRAPH_PREVIEW_SOURCE_DATABASE_URL" },
      row,
    ]);
    expect(await f.read()).toEqual({
      neonProjectId: input.neonProjectId,
      resourceId: input.resourceId,
    });
    expect(f.request.mock.calls).toEqual([
      [`/v9/projects/${input.sourceProjectId}/env`],
      [`/v1/projects/${input.sourceProjectId}/env/${row.id}`],
    ]);
  });

  it.each([
    { ...row, contentHint: { ...row.contentHint, type: "postgres-url" } },
    { ...row, contentHint: { ...row.contentHint, storeId: "store_foreign" } },
    { ...row, contentHint: { ...row.contentHint, integrationConfigurationId: "icfg_foreign" } },
    { ...row, contentHint: {} },
    { ...row, target: ["production"] },
    { ...row, target: [] },
    { ...row, gitBranch: "foreign-branch" },
    { ...row, key: "NEON_PROJECT_ID_CREDENTIAL" },
    { ...row, id: "" },
  ])("denies missing exact Preview linkage before reading any values", async (candidate) => {
    const f = fixture([candidate]);
    await expect(f.read()).rejects.toMatchObject({ code: "connection_required" });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it("rejects absent and ambiguous bindings without selecting a replacement", async () => {
    const absent = fixture([]);
    await expect(absent.read()).rejects.toMatchObject({ code: "connection_required" });
    const ambiguous = fixture([row, { ...row, id: "env_second", key: "ANOTHER_NEON_PROJECT_ID" }]);
    await expect(ambiguous.read()).rejects.toMatchObject({ code: "connection_required" });
    expect(absent.request).toHaveBeenCalledTimes(1);
    expect(ambiguous.request).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...row, id: "env_foreign" },
    { ...row, key: "ANOTHER_NEON_PROJECT_ID" },
    { ...row, contentHint: { ...row.contentHint, type: "postgres-url" } },
    { ...row, contentHint: { ...row.contentHint, storeId: "store_foreign" } },
    { ...row, contentHint: { ...row.contentHint, integrationConfigurationId: "icfg_foreign" } },
    { ...row, target: ["production"] },
    { ...row, gitBranch: "foreign-branch" },
    { ...row, value: "foreign-neon-project" },
    { ...row, value: "" },
  ])("rechecks row linkage and Neon identity after the metadata selection", async (changed) => {
    const f = fixture([row], { value: input.neonProjectId, ...changed });
    await expect(f.read()).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it("allows additional environments and ignores nonapplicable branch rows", async () => {
    const f = fixture(
      [
        { ...row, id: "env_branch", gitBranch: "another-branch" },
        { ...row, target: ["preview", "production"] },
      ],
      { ...row, target: ["preview", "production"], value: input.neonProjectId },
    );
    await expect(f.read()).resolves.toEqual({
      neonProjectId: input.neonProjectId,
      resourceId: input.resourceId,
    });
  });

  it("requires provider readback rather than returning configured IDs", async () => {
    const f = fixture([row], row);
    await expect(f.read()).rejects.toMatchObject({ code: "resource_mismatch" });
    f.request.mockResolvedValue({ envs: "invalid" });
    await expect(f.read()).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("preserves provider access failures without a storage fallback", async () => {
    const f = fixture();
    const denied = new Error("provider access denied");
    f.request.mockRejectedValue(denied);
    await expect(f.read()).rejects.toBe(denied);
    expect(f.request.mock.calls).toEqual([[`/v9/projects/${input.sourceProjectId}/env`]]);
  });

  it("accepts the supported null branch metadata without requiring a root configuration ID", async () => {
    const f = fixture([{ ...row, gitBranch: null }], {
      ...row,
      gitBranch: null,
      value: input.neonProjectId,
    });
    await expect(f.read()).resolves.toEqual({
      neonProjectId: input.neonProjectId,
      resourceId: input.resourceId,
    });
  });
});
