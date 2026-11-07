/* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity -- The two authenticated entry points explicitly dispatch their closed request union. */
import { setTimeout as delay } from "node:timers/promises";
import { RepositoryProductionDestinationRequiredError } from "./repository-production-destination";
import { z } from "zod";
import { appAccessCommandSchema, appAccessSnapshotSchema } from "../app-access/contracts";
import type { AppAccessCommand, AppAccessSnapshot } from "../app-access/contracts";
import { repositoryProductionApprovalInput } from "./repository-production-approval";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type {
  createRepositoryProductionSetup,
  RepositoryProductionSetupResult,
} from "./repository-production-setup";

export const repositoryProductionPath = "/v1/repository-production";
export const repositoryProductionCompletionPath = `${repositoryProductionPath}/access/complete`;
export type RepositoryProductionCompletion = "ready" | "pending";

/** Keep the authorized completion alive if the Auth browser needs a progress response. */
export const observeRepositoryProductionCompletion = async (
  work: Promise<RepositoryProductionCompletion>,
  waitUntil: (task: Promise<void>) => void,
  dispose: () => Promise<void>,
  responseBudgetMs = 1000,
): Promise<RepositoryProductionCompletion> => {
  const timer = new AbortController();
  const finish = async () => {
    try {
      await work;
    } catch {
      // The saved invitation and journal retain the state for the next callback.
    }
    try {
      await dispose();
    } catch {
      // Disposal cannot change the outcome of an already settled operation.
    }
  };
  waitUntil(finish());
  try {
    return await Promise.race([
      work,
      delay(responseBudgetMs, "pending" as const, { signal: timer.signal, ref: false }),
    ]);
  } finally {
    timer.abort();
  }
};
export interface RepositoryProductionRequestOwner {
  appId: string;
  sessionId: string;
  ownerContext: OperatorOwnerContext;
}
const ownerFields = {
  version: z.literal(1),
  appId: z.string().min(1),
  sessionId: z.string().min(1),
  ownerContext: operatorOwnerContextSchema,
};
export const repositoryProductionRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({ ...ownerFields, action: z.literal("plan") }),
  z.strictObject({ ...ownerFields, action: z.literal("setup-status") }),
  z.strictObject({
    ...ownerFields,
    action: z.literal("access-status"),
    cursor: z.string().optional(),
  }),
  z.strictObject({
    ...ownerFields,
    action: z.literal("access-command"),
    command: appAccessCommandSchema,
  }),
  z.strictObject({
    ...ownerFields,
    action: z.literal("prepare"),
    approvedByCallId: z.string().min(1),
  }),
]);
export interface RepositoryProductionHandlerDependencies {
  verifyBuilderWorkload: (request: Request) => Promise<void>;
  /** Verify the Auth sender for this invitation's saved realm, not merely any connected workload. */
  verifyAuthWorkload: (request: Request, invitationId: string) => Promise<void>;
  /** Re-reads canonical owner, acquired repository, approved source/access, and workspace Production binding. */
  resolvePlan: (
    owner: RepositoryProductionRequestOwner,
  ) => Promise<{ scope: RepositoryProductionScope; intent: RepositoryProductionIntent }>;
  readSetup: (owner: RepositoryProductionRequestOwner) => Promise<RepositoryProductionSetupResult>;
  resolveSetup: (
    owner: RepositoryProductionRequestOwner,
    approvedByCallId: string,
  ) => Promise<{
    scope: RepositoryProductionScope;
    intent: RepositoryProductionIntent;
    setup: ReturnType<typeof createRepositoryProductionSetup>;
  }>;
  management: {
    read: (owner: RepositoryProductionRequestOwner, cursor?: string) => Promise<AppAccessSnapshot>;
    execute: (
      owner: RepositoryProductionRequestOwner,
      command: AppAccessCommand,
    ) => Promise<AppAccessSnapshot>;
    completeInvitation: (invitationId: string) => Promise<RepositoryProductionCompletion>;
  };
}
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Serializes the already parsed closed responses from this HTTP boundary.
const reply = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });
/** Both entry points stay in the protected operator; the browser never receives provider credentials. */
export const createRepositoryProductionHandler =
  (deps: RepositoryProductionHandlerDependencies) => async (request: Request) => {
    const pathname = new URL(request.url).pathname;
    if (
      request.method !== "POST" ||
      ![repositoryProductionPath, repositoryProductionCompletionPath].includes(pathname)
    ) {
      return reply({ code: "not_found" }, 404);
    }
    let authenticated = false;
    try {
      if (pathname === repositoryProductionCompletionPath) {
        const body = z
          .strictObject({ version: z.literal(1), invitationId: z.uuid() })
          .safeParse(await request.json());
        if (!body.success) {
          return reply({ code: "request_invalid" }, 400);
        }
        await deps.verifyAuthWorkload(request, body.data.invitationId);
        authenticated = true;
        const status = await deps.management.completeInvitation(body.data.invitationId);
        return reply({ version: 1, status }, status === "ready" ? 200 : 202);
      }
      await deps.verifyBuilderWorkload(request);
      authenticated = true;
      const parsed = repositoryProductionRequestSchema.safeParse(await request.json());
      if (!parsed.success) {
        return reply({ code: "request_invalid" }, 400);
      }
      const body = parsed.data;
      if (body.sessionId !== body.ownerContext.sessionId) {
        return reply({ code: "app_access_denied" }, 403);
      }
      const owner = {
        appId: body.appId,
        sessionId: body.sessionId,
        ownerContext: body.ownerContext,
      };
      if (body.action === "plan") {
        const plan = await deps.resolvePlan(owner);
        return reply({
          version: 1,
          plan: repositoryProductionApprovalInput(plan.scope, plan.intent),
        });
      }
      if (body.action === "setup-status") {
        return reply({ version: 1, ...(await deps.readSetup(owner)) });
      }
      if (body.action === "access-status") {
        return reply(appAccessSnapshotSchema.parse(await deps.management.read(owner, body.cursor)));
      }
      if (body.action === "access-command") {
        return reply(
          appAccessSnapshotSchema.parse(await deps.management.execute(owner, body.command)),
        );
      }
      const resolved = await deps.resolveSetup(owner, body.approvedByCallId);
      if (resolved.scope.appId !== body.appId || resolved.intent.sessionId !== body.sessionId) {
        return reply({ code: "app_access_denied" }, 403);
      }
      const setup = await resolved.setup.prepare(resolved.scope, resolved.intent);
      return reply({
        version: 1,
        ...appAccessSnapshotSchema.parse(await deps.management.read(owner)),
        setup,
      });
    } catch (error) {
      if (!authenticated) {
        return reply({ code: "app_access_denied" }, 403);
      }
      if (
        error instanceof RepositoryProductionDestinationRequiredError &&
        pathname === repositoryProductionPath
      ) {
        return reply({ code: error.code }, 409);
      }
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      if (code === "app_access_denied" || code === "authorization_required") {
        return reply({ code: "app_access_denied" }, 403);
      }
      if (code === "request_id_conflict") {
        return reply({ code }, 409);
      }
      if (pathname === repositoryProductionCompletionPath) {
        return reply({ version: 1, status: "pending" }, 503);
      }
      return reply({ code: "app_access_unknown" }, 503);
    }
  };
