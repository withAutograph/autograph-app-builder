import { z } from "zod";

const jsonValueSchema = z.json();
export type MarketplaceJsonValue = z.infer<typeof jsonValueSchema>;

export type MarketplaceResourceErrorCode =
  | "connection_required"
  | "provider_unavailable"
  | "resource_mismatch";

const marketplaceStoreSchema = z.object({
  externalResourceId: z.string().min(1),
  id: z.string().min(1),
  ownerId: z.string().min(1),
  product: z.object({
    integrationConfigurationId: z.string().min(1),
    slug: z.literal("neon"),
  }),
  projectsMetadata: z.array(z.object({ projectId: z.string().min(1) })),
  status: z.literal("available"),
  type: z.literal("integration"),
});
const marketplaceStoreDetailSchema = z.object({ store: marketplaceStoreSchema });

const listedStoreSchema = z.object({
  id: z.string().min(1),
  product: z.object({
    integrationConfigurationId: z.string().min(1),
    slug: z.literal("neon"),
  }),
  projectsMetadata: z.array(z.object({ projectId: z.string().min(1) })),
  status: z.literal("available"),
  type: z.literal("integration"),
});

const resourceListSchema = z.object({ stores: z.array(jsonValueSchema) });

/**
 * Resolves the native Neon marketplace resource already connected to one exact
 * Vercel project. The Vercel store endpoint can include credentials, so this
 * function parses only allowlisted identity fields and returns no raw payload.
 */
export const readVercelManagedNeonResource = async (input: {
  configurationId: string;
  fail: (code: MarketplaceResourceErrorCode) => Error;
  projectId: string;
  request: (path: string) => Promise<MarketplaceJsonValue>;
  scopeId: string;
}) => {
  const listedPayload = resourceListSchema.safeParse(await input.request("/v1/storage/stores"));
  if (!listedPayload.success) {
    throw input.fail("provider_unavailable");
  }

  const candidates = listedPayload.data.stores.flatMap((rawStore) => {
    const parsed = listedStoreSchema.safeParse(rawStore);
    if (
      !parsed.success ||
      parsed.data.product.integrationConfigurationId !== input.configurationId ||
      !parsed.data.projectsMetadata.some((project) => project.projectId === input.projectId)
    ) {
      return [];
    }
    return [parsed.data];
  });
  if (candidates.length !== 1) {
    throw input.fail("connection_required");
  }

  const [listed] = candidates;
  if (listed === undefined) {
    throw input.fail("connection_required");
  }
  const detailPayload = await input.request(`/v1/storage/stores/${encodeURIComponent(listed.id)}`);
  const detail = marketplaceStoreDetailSchema.safeParse(detailPayload);
  if (!detail.success) {
    throw input.fail("resource_mismatch");
  }
  const verified = detail.data.store;
  if (verified.id !== listed.id || verified.ownerId !== input.scopeId) {
    throw input.fail("resource_mismatch");
  }
  if (verified.product.integrationConfigurationId !== input.configurationId) {
    throw input.fail("resource_mismatch");
  }
  if (!verified.projectsMetadata.some((project) => project.projectId === input.projectId)) {
    throw input.fail("resource_mismatch");
  }

  return {
    neonProjectId: verified.externalResourceId,
    resourceId: verified.id,
  };
};
