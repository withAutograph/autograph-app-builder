import { createHash } from "node:crypto";
import type { AgentModelOptionsDefinition } from "eve";

type ProviderOptions = NonNullable<AgentModelOptionsDefinition["providerOptions"]>;

/** Reporting only: this identifies a native adapter, never the canonical public session. */
export const withBuilderGatewayReporting = (
  options: ProviderOptions,
  nativeSessionId: () => string | undefined,
  callsite: "main" | "source-review",
): ProviderOptions => {
  try {
    const sessionId = nativeSessionId();
    if (sessionId === undefined || sessionId === "") {
      return options;
    }
    const gateway = options.gateway ?? {};
    // Null is existing unsupported metadata, not a request to replace caller tags.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- Preserve null and other unsupported tag values unchanged.
    const existingTags = gateway.tags === undefined ? [] : gateway.tags;
    if (
      !Array.isArray(existingTags) ||
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve unsupported caller metadata unchanged rather than repairing or discarding its tags.
      !existingTags.every((tag): tag is string => typeof tag === "string")
    ) {
      return options;
    }
    const nativeHash = createHash("sha256")
      .update(JSON.stringify(["builder-native-session-attribution-v1", sessionId]))
      .digest("hex");
    const additions = [
      `builder-native-sha256:${nativeHash}`,
      `builder-callsite:${callsite}`,
    ].filter((tag) => !existingTags.includes(tag));
    return {
      ...options,
      gateway: { ...gateway, tags: [...existingTags, ...additions] },
    };
  } catch {
    // Missing reporting context or metadata cannot change the model request.
    return options;
  }
};
