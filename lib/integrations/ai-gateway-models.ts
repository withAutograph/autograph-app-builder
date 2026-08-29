import { z } from "zod";

import {
  builderModelSchema,
  type BuilderIntegrationState,
} from "./builder-state";

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const CACHE_MS = 5 * 60_000;

const gatewayModelSchema = z
  .object({
    id: z.string().min(3).max(256),
    name: z.string().min(1).max(256),
    owned_by: z.string().min(1).max(128),
    type: z.string().max(64),
    zdr: z.enum(["all", "some", "none"]).catch("none"),
    tags: z.array(z.string().min(1).max(128)).max(64).default([]),
  })
  .passthrough();

const responseSchema = z
  .object({ data: z.array(gatewayModelSchema).max(1_000) })
  .passthrough();

type ModelState = BuilderIntegrationState["models"];
let cached: { value: ModelState; expiresAt: number } | undefined;

export async function loadGatewayModels(input?: {
  fetch?: typeof fetch;
  now?: () => number;
  defaultModelId?: string;
  force?: boolean;
}): Promise<ModelState> {
  const now = input?.now?.() ?? Date.now();
  if (!input?.force && cached && cached.expiresAt > now)
    return { ...cached.value, cached: true };

  try {
    const response = await (input?.fetch ?? fetch)(GATEWAY_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("gateway-models-unavailable");
    const parsed = responseSchema.parse(await response.json());
    const entries = parsed.data
      .filter((model) => model.type === "language")
      .map((model) =>
        builderModelSchema.parse({
          id: model.id,
          name: model.name,
          provider: model.owned_by,
          capabilities: model.tags,
          zdr: model.zdr,
        }),
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) throw new Error("gateway-models-empty");
    const defaultModelId = entries.some(
      (entry) => entry.id === input?.defaultModelId,
    )
      ? input?.defaultModelId
      : undefined;
    const value: ModelState = {
      status: "ready",
      entries,
      ...(defaultModelId ? { defaultModelId } : {}),
      cached: false,
    };
    cached = { value, expiresAt: now + CACHE_MS };
    return value;
  } catch {
    if (cached) return { ...cached.value, cached: true };
    return { status: "unavailable", entries: [], cached: false };
  }
}

export function resetGatewayModelCacheForTests() {
  cached = undefined;
}
