import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { builderPublicOriginSelectionSchema } from "./builder-public-origin-contract";
import type {
  BuilderPublicOriginActionState,
  BuilderPublicOriginScope,
} from "./builder-public-origin-contract";
import type { BuilderDestinationEpoch } from "./builder-session-destination-contract";
import type { BuilderPublicOriginStore } from "./builder-public-origin-store";

const authorityFor = (principal: HostedPrincipal) => ({
  audience: principal.audience,
  issuer: principal.issuer,
  ownerUserId: principal.ownerUserId,
  workspaceId: principal.workspaceId,
});
export const createBuilderPublicOriginService = (deps: {
  store: BuilderPublicOriginStore;
  resolve: (
    principal: HostedPrincipal,
    sessionId: string,
  ) => Promise<{
    scope: BuilderPublicOriginScope;
    expected: BuilderDestinationEpoch;
    assertCurrent: () => Promise<void>;
    readOrigins: () => Promise<string[]>;
  }>;
}) => ({
  read: async (principal: HostedPrincipal, sessionId: string) => {
    const target = await deps.resolve(principal, sessionId);
    const origins = await target.readOrigins();
    await target.assertCurrent();
    const selectedPublicOrigin = await deps.store.read({
      authority: authorityFor(principal),
      scope: target.scope,
    });
    await target.assertCurrent();
    return {
      expected: target.expected,
      origins,
      scope: target.scope,
      selectedPublicOrigin: selectedPublicOrigin ?? null,
    };
  },
  select: async (
    principal: HostedPrincipal,
    input: z.infer<typeof builderPublicOriginSelectionSchema>,
  ) => {
    const selected = builderPublicOriginSelectionSchema.parse(input);
    const target = await deps.resolve(principal, selected.sessionId);
    if (
      !isDeepStrictEqual(target.scope, selected.scope) ||
      !isDeepStrictEqual(target.expected, selected.expected)
    ) {
      throw new Error("builder_public_origin_stale");
    }
    const origins = await target.readOrigins();
    if (!origins.includes(selected.publicOrigin)) {
      throw new Error("builder_public_origin_unavailable");
    }
    await target.assertCurrent();
    await deps.store.select({
      assertCurrent: target.assertCurrent,
      authority: authorityFor(principal),
      expectedPublicOrigin: selected.expectedPublicOrigin,
      publicOrigin: selected.publicOrigin,
      scope: target.scope,
    });
    await target.assertCurrent();
  },
});

/** Same-origin web choice only. This action has no provisioning or publication port. */
export const createBuilderPublicOriginAction =
  (ports: {
    origin: string;
    enabled: () => Promise<boolean>;
    open: (headers: Headers) => Promise<{
      principal: HostedPrincipal;
      publicOrigins: Pick<ReturnType<typeof createBuilderPublicOriginService>, "select">;
    }>;
    refresh: () => void;
  }) =>
  async (
    input: z.infer<typeof builderPublicOriginSelectionSchema>,
    headers: Headers,
  ): Promise<BuilderPublicOriginActionState> => {
    try {
      const parsed = builderPublicOriginSelectionSchema.parse(input);
      if (headers.get("origin") !== ports.origin || !(await ports.enabled())) {
        return {
          message: "Public domain selection is unavailable. Your app is preserved.",
          status: "error",
        };
      }
      const context = await ports.open(headers);
      await context.publicOrigins.select(context.principal, parsed);
      ports.refresh();
      return {
        message:
          "Public domain selected. Continue the saved build to review its fresh Auth and release plan.",
        status: "ready",
      };
    } catch {
      return {
        message:
          "The domain choice changed or is unavailable. Refresh this page; your app and previous approvals are preserved.",
        status: "error",
      };
    }
  };
