import { z } from "zod";

import { builderModelSchema } from "./builder-state";
import type { BuilderIntegrationState } from "./builder-state";
import { activeBuilderModelId } from "./active-model";

const GATEWAY_MODELS_URL = "https://ai-gateway.vercel.sh/v1/models";

const gatewayModelSchema = z
  .object({
    id: z.string().min(3).max(256),
    name: z.string().min(1).max(256),
    owned_by: z.string().min(1).max(128),
    type: z.string().max(64),
    // Zod's schema fallback API is not a Promise method.
    // oxlint-disable-next-line promise/prefer-await-to-then
    zdr: z.enum(["all", "some", "none"]).catch("none"),
    tags: z.array(z.string().min(1).max(128)).max(64).default([]),
  })
  .passthrough();

const responseSchema = z.object({ data: z.array(gatewayModelSchema).max(1000) }).passthrough();

type ModelState = BuilderIntegrationState["models"];
// Availability fallback only, never a freshness cache. The Next adapter owns TTL.
let lastKnownGood: ModelState | undefined;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function loadGatewayModels(input?: {
  fetch?: typeof fetch;
  defaultModelId?: string;
}): Promise<ModelState> {
  try {
    const response = await (input?.fetch ?? fetch)(GATEWAY_MODELS_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
      cache: "no-store",
    });
    if (!response.ok) throw new Error("gateway-models-unavailable");
    const parsed = responseSchema.parse(await response.json());
    const entries = parsed.data
      .filter((model) => model.type === "language" && model.owned_by === "openai")
      .map((model) =>
        builderModelSchema.parse({
          id: model.id,
          name: model.name,
          provider: model.owned_by,
          capabilities: model.tags,
          zdr: model.zdr,
        }),
      )
      .toSorted((left, right) => left.name.localeCompare(right.name));
    if (entries.length === 0) throw new Error("gateway-models-empty");
    const defaultModelId = entries.some((entry) => entry.id === activeBuilderModelId)
      ? activeBuilderModelId
      : undefined;
    const value: ModelState = {
      status: "ready",
      entries,
      ...(defaultModelId ? { defaultModelId } : {}),
      cached: false,
    };
    lastKnownGood = value;
    return value;
  } catch {
    if (lastKnownGood) return { ...lastKnownGood, cached: true };
    return { status: "unavailable", entries: [], cached: false };
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function resetGatewayModelCacheForTests() {
  lastKnownGood = undefined;
}
