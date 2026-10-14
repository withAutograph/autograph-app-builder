import { z } from "zod";
import type {
  MarketplaceJsonValue,
  MarketplaceResourceErrorCode,
} from "./hosted-runtime-marketplace-resource";

const identity = z.string().min(1);
const bindingRow = z.object({
  id: identity,
  key: z.string().regex(/^(?:[A-Z][A-Z0-9_]*_)?NEON_PROJECT_ID$/u),
  contentHint: z.object({
    type: z.literal("integration-store-secret"),
    storeId: identity,
    integrationConfigurationId: identity,
  }),
  target: z.array(z.string()).refine((targets) => targets.includes("preview")),
  gitBranch: z.null().optional(),
});
const identityRow = bindingRow.extend({ value: identity });
const metadataRows = z.object({ envs: z.array(z.json()) });

/** Read only the provider-maintained nonsecret Neon project identity on the approved source project. */
export const readVercelNativeNeonBinding = async (input: {
  sourceProjectId: string;
  configurationId: string;
  resourceId: string;
  neonProjectId: string;
  request: (path: string) => Promise<MarketplaceJsonValue>;
  fail: (code: MarketplaceResourceErrorCode) => Error;
}) => {
  const project = encodeURIComponent(input.sourceProjectId);
  const metadata = metadataRows.safeParse(await input.request(`/v9/projects/${project}/env`));
  if (!metadata.success) {
    throw input.fail("provider_unavailable");
  }
  const candidates = metadata.data.envs.flatMap((row) => {
    const parsed = bindingRow.safeParse(row);
    if (
      !parsed.success ||
      parsed.data.contentHint.storeId !== input.resourceId ||
      parsed.data.contentHint.integrationConfigurationId !== input.configurationId
    ) {
      return [];
    }
    return [parsed.data];
  });
  const [selected] = candidates;
  if (candidates.length !== 1 || selected === undefined) {
    throw input.fail("connection_required");
  }
  const detail = identityRow.safeParse(
    await input.request(`/v1/projects/${project}/env/${encodeURIComponent(selected.id)}`),
  );
  if (!detail.success) {
    throw input.fail("resource_mismatch");
  }
  const verified = detail.data;
  const mismatches = [
    verified.id !== selected.id,
    verified.key !== selected.key,
    verified.contentHint.storeId !== input.resourceId,
    verified.contentHint.integrationConfigurationId !== input.configurationId,
    verified.value !== input.neonProjectId,
  ];
  if (mismatches.some(Boolean)) {
    throw input.fail("resource_mismatch");
  }
  return { neonProjectId: verified.value, resourceId: verified.contentHint.storeId };
};
