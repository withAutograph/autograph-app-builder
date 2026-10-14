import { isDeepStrictEqual } from "node:util";
import { verifyVercelOidcToken } from "@vercel/oidc";
import { createRemoteJWKSet, customFetch } from "jose";
import { z } from "zod";
import { createNormalActorCaptureHandler } from "./hosted-operator-normal-actor-capture";
import type { NormalActorCapturePorts } from "./hosted-operator-normal-actor-capture";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import { createHostedOperatorNormalAuthClient } from "./hosted-operator-normal-auth-client";
import { createHostedOperatorNormalAuthTransport } from "./hosted-operator-normal-auth-transport";
import { createHostedOperatorRealmHttpTransport } from "./hosted-operator-realm-http-transport";
import { projectPendingRealmIdentityLink } from "./hosted-operator-contract";
import type { openHostedOperatorCompositionResources } from "./hosted-operator-source-configuration";

type CompositionResources = Awaited<ReturnType<typeof openHostedOperatorCompositionResources>>;
export interface NormalActorCaptureDeploymentResources {
  configuration: CompositionResources["configuration"];
  controlPlane: Pick<
    CompositionResources["controlPlane"],
    | "normalActorJournalPorts"
    | "assertPlanningAuthorized"
    | "readPendingNormalActorCapture"
    | "readPendingRealmIdentityLinkForStaging"
    | "close"
  >;
}
export interface NormalActorCaptureDeploymentIo {
  openResources?: (
    environment: Readonly<Record<string, string | undefined>>,
  ) => Promise<NormalActorCaptureDeploymentResources>;
  verifySender?: NormalActorCapturePorts["verifySender"];
  verifyNativeToken?: (
    token: string,
    options: Parameters<typeof verifyVercelOidcToken>[1],
  ) => Promise<{ payload: unknown }>;
  realmTransport?: typeof createHostedOperatorRealmHttpTransport;
  normalTransport?: typeof createHostedOperatorNormalAuthTransport;
  keySet?: typeof createRemoteJWKSet;
}
const senderClaimsSchema = z.object({
  iss: z.string(),
  aud: z.string(),
  owner_id: z.string(),
  project_id: z.string(),
  environment: z.string(),
  sub: z.string(),
});
const unavailable = () => new Error("realm_browser_session_capture_unavailable");

/** Real private route assembly: policy and nonce context come only from the opened owner resources. */
export const createNormalActorCaptureDeploymentPorts = (
  resources: NormalActorCaptureDeploymentResources,
  io: NormalActorCaptureDeploymentIo = {},
): NormalActorCapturePorts => {
  const { configuration, controlPlane } = resources;
  const configuredSender = configuration.gateway.workload;
  if (
    configuredSender.environment !== "preview" ||
    configuredSender.projectId !== configuration.gateway.projectId ||
    configuredSender.ownerId !== configuration.teamId
  ) {
    throw unavailable();
  }
  return {
    builderOrigin: configuration.builderCallbackOrigin,
    sender: { ...configuredSender, environment: "preview" },
    now: Date.now,
    journal: createNormalActorJournal(controlPlane.normalActorJournalPorts),
    verifySender:
      io.verifySender ??
      (async (token, sender) => {
        const verified = await (io.verifyNativeToken ?? verifyVercelOidcToken)(token, {
          audience: sender.audience,
          issuer: sender.issuer,
          ownerId: sender.ownerId,
          projectId: sender.projectId,
          environment: sender.environment,
          subject: sender.subject,
        });
        return senderClaimsSchema.parse(verified.payload);
      }),
    async pending(selector) {
      const captured = await controlPlane.readPendingNormalActorCapture(selector);
      // The physical Auth binding is re-read after the canonical actor mapping and original account approval.
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await
      const staging = await controlPlane.readPendingRealmIdentityLinkForStaging(selector);
      const { context, preparation, link } = captured;
      const gateway = preparation.accountPlan.publicGateway;
      const matches = [
        gateway?.projectId === configuration.gateway.projectId,
        gateway?.projectId === configuredSender.projectId,
        gateway?.branch === configuration.gateway.branch,
        gateway?.branch === context.target.branch,
        preparation.program.origin === configuration.gateway.publicOrigin,
        link.browserOrigin === preparation.program.origin,
        link.organizationId === null,
        link.bootstrapPlanDigest === preparation.accountPlanDigest,
        link.browserSession?.operationRef === preparation.accountOperationRef,
        link.browserSession?.participantProgramDigest === preparation.programDigest,
        staging.jwksUrl === `${link.endpointOrigin}/_platform/jwks.json`,
        isDeepStrictEqual(staging.link, projectPendingRealmIdentityLink(link)),
      ].every(Boolean);
      if (!matches) {
        throw unavailable();
      }
      const transport = (io.realmTransport ?? createHostedOperatorRealmHttpTransport)(
        configuration,
        "builder",
        undefined,
        link.endpointOrigin,
      );
      return {
        context,
        actorKey: captured.actorKey,
        organizationId: captured.organizationId,
        link: projectPendingRealmIdentityLink(link),
        resource: staging.bootstrapResource,
        getKey: (io.keySet ?? createRemoteJWKSet)(new URL(staging.jwksUrl), {
          [customFetch]: transport,
        }),
        readback: async (request) => await transport(request),
        assertCurrent: async () => {
          await controlPlane.normalActorJournalPorts.assertAuthorized(context);
          const latest = await controlPlane.readPendingNormalActorCapture(selector);
          const current = [
            isDeepStrictEqual(latest.context, context),
            latest.preparation.accountOperationRef === preparation.accountOperationRef,
            latest.preparation.accountPlanDigest === preparation.accountPlanDigest,
            latest.preparation.programDigest === preparation.programDigest,
            latest.actorKey === captured.actorKey,
            latest.organizationId === captured.organizationId,
            isDeepStrictEqual(latest.link, link),
          ].every(Boolean);
          if (!current) {
            throw unavailable();
          }
        },
      };
    },
    async verifyCapturedActor(input) {
      const transport = await (io.normalTransport ?? createHostedOperatorNormalAuthTransport)({
        configuration,
        context: input.context,
        origin: input.program.origin,
        sourceHost: "builder",
        assertPlanningAuthorized: controlPlane.assertPlanningAuthorized,
        assertCurrentOwner: controlPlane.normalActorJournalPorts.assertAuthorized,
      });
      const cookie = input.normalCookie;
      // A leading dot encodes the existing Domain-cookie semantics in Playwright storage;
      // the actual domain, path and bytes are preserved, without moving the cookie to another host.
      const storageCookie = {
        ...cookie,
        domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain.replace(/^\./u, "")}`,
      };
      const client = createHostedOperatorNormalAuthClient({
        origin: input.program.origin,
        fetch: transport,
        storageState: { cookies: [storageCookie], origins: [] },
      });
      return await client.getSession();
    },
  };
};

/** Native sender POST only; capture does not consume the human owner-confirmation nonce. */
export const createNormalActorCaptureDeploymentHandler =
  (
    environment: Readonly<Record<string, string | undefined>> = process.env,
    io: NormalActorCaptureDeploymentIo = {},
  ) =>
  async (request: Request): Promise<Response> => {
    let resources: NormalActorCaptureDeploymentResources | undefined;
    try {
      const open =
        io.openResources ??
        (async (settings) => {
          const deployment = await import("./hosted-operator-source-configuration");
          return await deployment.openHostedOperatorCompositionResources(settings);
        });
      resources = await open(environment);
      return await createNormalActorCaptureHandler(
        createNormalActorCaptureDeploymentPorts(resources, io),
      )(request);
    } catch {
      return Response.json(
        { error: "realm_browser_session_capture_unavailable" },
        {
          status: 403,
          headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
        },
      );
    } finally {
      await resources?.controlPlane.close();
    }
  };
