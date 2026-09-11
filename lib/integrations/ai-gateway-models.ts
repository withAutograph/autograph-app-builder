import { z } from "zod";

import { activeBuilderModelId } from "./active-model";
import { builderModelSchema } from "./builder-state";
import type { BuilderIntegrationState } from "./builder-state";

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";
const CACHE_MS = 5 * 60_000;

const gatewayModelSchema = z
  .object({
    id: z.string().min(3).max(256),
    name: z.string().min(1).max(256),
    owned_by: z.string().min(1).max(128),
    tags: z.array(z.string().min(1).max(128)).max(64).default([]),
    type: z.string().max(64),
    zdr: z.enum(["all", "some", "none"]).catch("none"),
  })
  .passthrough();

const responseSchema = z
  .object({ data: z.array(gatewayModelSchema).max(1000) })
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
  if (!input?.force && cached && cached.expiresAt > now) {
    return { ...cached.value, cached: true };
  }

  try {
    const response = await (input?.fetch ?? fetch)(GATEWAY_MODELS_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error("gateway-models-unavailable");
    }
    const parsed = responseSchema.parse(await response.json());
    const entries = parsed.data
      .filter(
        (model) => model.type === "language" && model.owned_by === "openai"
      )
      .map((model) =>
        builderModelSchema.parse({
          capabilities: model.tags,
          id: model.id,
          name: model.name,
          provider: model.owned_by,
          zdr: model.zdr,
        })
      )
      .sort((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) {
      throw new Error("gateway-models-empty");
    }
    const defaultModelId = entries.some(
      (entry) => entry.id === activeBuilderModelId
    )
      ? activeBuilderModelId
      : undefined;
    const value: ModelState = {
      status: "ready",
      entries,
      ...(defaultModelId ? { defaultModelId } : {}),
      cached: false,
    };
    cached = { expiresAt: now + CACHE_MS, value };
    return value;
  } catch {
    if (cached) {
      return { ...cached.value, cached: true };
    }
    return { cached: false, entries: [], status: "unavailable" };
  }
}

export function resetGatewayModelCacheForTests() {
  cached = undefined;
}
