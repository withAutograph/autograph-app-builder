import { describe, expect, it, vi } from "vitest";

import { readVercelManagedNeonResource } from "./hosted-runtime-marketplace-resource";
import type { MarketplaceResourceErrorCode } from "./hosted-runtime-marketplace-resource";

const projectId = "prj_services";
const configurationId = "icfg_neon";
const scopeId = "team_owner";
const listedStore = {
  id: "store_neon",
  name: "Arrusted Neon",
  product: { integrationConfigurationId: configurationId, slug: "neon" },
  projectsMetadata: [{ name: "services", projectId }],
  secrets: [{ name: "POSTGRES_PASSWORD", value: "never-return-this" }],
  status: "available",
  type: "integration",
};
const storeDetail = {
  ...listedStore,
  externalResourceId: "bitter-lab-49627418",
  ownerId: scopeId,
  product: {
    ...listedStore.product,
    id: "iap_neon",
    integration: { capabilities: { mcp: true }, id: "oac_neon" },
  },
  secrets: [{ name: "POSTGRES_PASSWORD", value: "must-not-escape" }],
};

const fail = (code: MarketplaceResourceErrorCode) => Object.assign(new Error(code), { code });

describe("Vercel-managed Neon resource readback", () => {
  it("binds the exact installed Neon resource to its Vercel project without returning secrets", async () => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning Vercel API fixture.
    const request = vi.fn(async (path: string) => {
      if (path === "/v1/storage/stores") {
        return { stores: [listedStore] };
      }
      expect(path).toBe("/v1/storage/stores/store_neon");
      return { secrets: [{ value: "top-level-secret" }], store: storeDetail };
    });

    const resource = await readVercelManagedNeonResource({
      configurationId,
      fail,
      projectId,
      request,
      scopeId,
    });

    expect(resource).toEqual({
      neonProjectId: "bitter-lab-49627418",
      resourceId: "store_neon",
    });
    expect(JSON.stringify(resource)).not.toContain("never-return-this");
    expect(JSON.stringify(resource)).not.toContain("must-not-escape");
    expect(JSON.stringify(resource)).not.toContain("top-level-secret");
    expect(request.mock.calls).toEqual([["/v1/storage/stores"], ["/v1/storage/stores/store_neon"]]);
  });

  it.each([
    {
      ...listedStore,
      product: { ...listedStore.product, integrationConfigurationId: "icfg_other" },
    },
    { ...listedStore, projectsMetadata: [{ name: "other", projectId: "prj_other" }] },
    { ...listedStore, status: "error" },
    { ...listedStore, type: "blob" },
  ])("does not select a store without exact project and integration metadata", async (store) => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning Vercel API fixture.
    const request = vi.fn(async () => ({ stores: [store] }));

    await expect(
      readVercelManagedNeonResource({ configurationId, fail, projectId, request, scopeId }),
    ).rejects.toMatchObject({ code: "connection_required" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects multiple linked Neon resources instead of guessing", async () => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning Vercel API fixture.
    const request = vi.fn(async () => ({
      stores: [listedStore, { ...listedStore, id: "store_neon_2" }],
    }));

    await expect(
      readVercelManagedNeonResource({ configurationId, fail, projectId, request, scopeId }),
    ).rejects.toMatchObject({ code: "connection_required" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects a detail readback owned by another Vercel scope", async () => {
    // oxlint-disable-next-line eslint/require-await -- Promise-returning Vercel API fixture.
    const request = vi.fn(async (path: string) =>
      path === "/v1/storage/stores"
        ? { stores: [listedStore] }
        : { store: { ...storeDetail, ownerId: "team_other" } },
    );

    await expect(
      readVercelManagedNeonResource({ configurationId, fail, projectId, request, scopeId }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });
});
