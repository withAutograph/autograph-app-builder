/* oxlint-disable eslint/complexity, sonarjs/cognitive-complexity -- The native capture transaction retains ordered source selection, owner scope, signed sender and cleanup checks; no effect is retried or parallelized. */
import { isDeepStrictEqual } from "node:util";
import { verifyVercelOidcToken } from "@vercel/oidc";
import { createRemoteJWKSet, customFetch } from "jose";
import { z } from "zod";
import { realmIdentityNonceSha256 } from "./hosted-operator-auth-identity";
import {
  operatorOwnerContextSchema,
  projectPendingRealmIdentityLink,
} from "./hosted-operator-contract";
import {
  normalActorCaptureRequestSchema,
  createNormalActorCaptureHandler,
} from "./hosted-operator-normal-actor-capture";
import type { NormalActorCapturePorts } from "./hosted-operator-normal-actor-capture";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import { createHostedOperatorNormalAuthClient } from "./hosted-operator-normal-auth-client";
import { createHostedOperatorNormalAuthTransport } from "./hosted-operator-normal-auth-transport";
import { createHostedOperatorRealmHttpTransport } from "./hosted-operator-realm-http-transport";
import type { openHostedOperatorCompositionResources } from "./hosted-operator-source-configuration";

type CompositionResources = Awaited<ReturnType<typeof openHostedOperatorCompositionResources>>;
export interface NormalActorCaptureDeploymentResources {
  configuration: CompositionResources["configuration"];
  publicRealm?: Awaited<
    ReturnType<CompositionResources["controlPlane"]["readPendingRealmIdentityLinkForStaging"]>
  >["publicRealm"];

  controlPlane: Pick<
    CompositionResources["controlPlane"],
    | "normalActorJournalPorts"
    | "assertPlanningAuthorized"
    | "readPendingNormalActorCapture"
    | "readPendingRealmIdentityLinkForStaging"
    | "close"
    | "resolveRealmIdentityCallbackOwnerContext"
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
  const configuredSender = resources.publicRealm?.sender ?? configuration.gateway.workload;
  if (
    (resources.publicRealm === undefined && configuredSender.environment !== "preview") ||
    configuredSender.projectId !== configuration.gateway.projectId ||
    configuredSender.ownerId !== configuration.teamId
  ) {
    throw unavailable();
  }
  return {
    builderOrigin: configuration.builderCallbackOrigin,
    sender:
      resources.publicRealm === undefined
        ? { ...configuration.gateway.workload, environment: "preview" }
        : { ...resources.publicRealm.sender, publicEnrollment: resources.publicRealm.enrollment },
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
        resources.publicRealm !== undefined || gateway?.branch === context.target.branch,
        preparation.program.origin === configuration.gateway.publicOrigin,
        link.browserOrigin === preparation.program.origin,
        link.organizationId === null,
        link.bootstrapPlanDigest === preparation.accountPlanDigest,
        link.browserSession?.operationRef === preparation.accountOperationRef,
        link.browserSession?.participantProgramDigest === preparation.programDigest,
        staging.jwksUrl === `${link.endpointOrigin}/_platform/jwks.json`,
        isDeepStrictEqual(staging.link, projectPendingRealmIdentityLink(link)),
        isDeepStrictEqual(staging.publicRealm, resources.publicRealm),
        isDeepStrictEqual(staging.publicRealm, resources.publicRealm),
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
          [customFetch]: async (...args) => {
            const response = await transport(...args);
            const pin = resources.publicRealm?.publicJwk;
            if (pin === undefined || !response.ok) {
              return response;
            }
            const payload = z
              .object({ keys: z.array(z.record(z.string(), z.unknown())) })
              .parse(await response.json());
            if (
              !payload.keys.some(
                (key) =>
                  key.kty === pin.kty &&
                  key.crv === pin.crv &&
                  key.x === pin.x &&
                  key.kid === pin.kid,
              )
            ) {
              throw unavailable();
            }
            return Response.json({ keys: [pin] });
          },
        }),
        readback: async (request) => await transport(request),
        assertCurrent: async () => {
          await controlPlane.normalActorJournalPorts.assertAuthorized(context);
          const latest = await controlPlane.readPendingNormalActorCapture(selector);
          // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Revalidate public release authority after the canonical current capture snapshot.
          const latestStaging = await controlPlane.readPendingRealmIdentityLinkForStaging(selector);
          if (!isDeepStrictEqual(latestStaging.publicRealm, resources.publicRealm)) {
            throw unavailable();
          }
          // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Revalidate public release authority after the canonical current capture snapshot.
          // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Revalidate public release authority after the canonical current capture snapshot.

          if (!isDeepStrictEqual(latestStaging.publicRealm, resources.publicRealm)) {
            throw unavailable();
          }
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
    let initialResources: typeof resources;

    try {
      const open =
        io.openResources ??
        (async (settings) => {
          const deployment = await import("./hosted-operator-source-configuration");
          return await deployment.openHostedOperatorCompositionResources(settings);
        });
      resources = await open(environment);
      initialResources = resources;
      if (
        environment.PROTECTED_HOSTED_OPERATOR_STANDARD_RUNTIME_PROFILES !== undefined ||
        resources.configuration.standardDevelopmentRuntime !== undefined
      ) {
        // Routing hint only; the ordinary handler still verifies native sender,
        // nonce, public approval, signed proof and actual cookie before capture.
        const clone = request.clone();
        const reader = clone.body?.getReader();
        if (reader === undefined) {
          throw unavailable();
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Consume the bounded routing copy in stream order.
          const next = await reader.read();
          if (next.done) {
            break;
          }
          size += next.value.byteLength;
          if (size > 32_768) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Stop the bounded stream before rejecting an oversized routing copy.
            await reader.cancel();
            throw unavailable();
          }
          chunks.push(next.value);
        }
        const hint = normalActorCaptureRequestSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf-8")),
        );
        const selector = {
          ownerSessionId: hint.ownerSessionId,
          nonceSha256: realmIdentityNonceSha256(hint.reviewedNonce),
        };
        const selected =
          await resources.controlPlane.resolveRealmIdentityCallbackOwnerContext(selector);
        if (selected.publicRelease !== undefined) {
          const {
            openNativeTargetConfigurationResources,
            resolveOwnedStandardRuntimeConfiguration,
          } = await import("./native-target-configuration-resolver");
          const { openHostedOperatorConfigurationResources } =
            await import("./hosted-operator-source-configuration");
          const native = await openNativeTargetConfigurationResources(
            resources.configuration,
            environment,
          );
          try {
            const configuration = await resolveOwnedStandardRuntimeConfiguration({
              configuration: resources.configuration,
              resources: native,
              environment,
              context: {
                authority: selected.context.authority,
                ownerContext: operatorOwnerContextSchema.parse(selected.context.ownerContext),
                target: {
                  appId: selected.context.target.appId,
                  sessionId: selected.context.target.sessionId,
                },
              },
            });
            const canonical = await openHostedOperatorConfigurationResources(
              configuration,
              environment,
            );
            resources = canonical;
            const staging =
              await canonical.controlPlane.readPendingRealmIdentityLinkForStaging(selector);
            if (staging.publicRealm === undefined) {
              throw unavailable();
            }
            resources = { ...canonical, publicRealm: staging.publicRealm };
          } finally {
            await native.close();
          }
        }
      }
      initialResources = resources;
      if (
        environment.PROTECTED_HOSTED_OPERATOR_STANDARD_RUNTIME_PROFILES !== undefined ||
        resources.configuration.standardDevelopmentRuntime !== undefined
      ) {
        // Routing hint only; the ordinary handler still verifies native sender,
        // nonce, public approval, signed proof and actual cookie before capture.
        const clone = request.clone();
        const reader = clone.body?.getReader();
        if (reader === undefined) {
          throw unavailable();
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          // oxlint-disable-next-line eslint/no-await-in-loop -- Consume the bounded routing copy in stream order.
          // oxlint-disable-next-line eslint/no-await-in-loop -- Consume the bounded routing copy in stream order.
          const next = await reader.read();
          if (next.done) {
            break;
          }
          size += next.value.byteLength;
          if (size > 32_768) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- Stop the bounded stream before rejecting an oversized routing copy.
            // oxlint-disable-next-line eslint/no-await-in-loop -- Stop the bounded stream before rejecting an oversized routing copy.
            await reader.cancel();
            throw unavailable();
          }
          chunks.push(next.value);
        }
        const hint = normalActorCaptureRequestSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString("utf-8")),
        );
        const selector = {
          ownerSessionId: hint.ownerSessionId,
          nonceSha256: realmIdentityNonceSha256(hint.reviewedNonce),
        };
        const selected =
          await resources.controlPlane.resolveRealmIdentityCallbackOwnerContext(selector);
        if (selected.publicRelease !== undefined) {
          const {
            openNativeTargetConfigurationResources,
            resolveOwnedStandardRuntimeConfiguration,
          } = await import("./native-target-configuration-resolver");
          const { openHostedOperatorConfigurationResources } =
            await import("./hosted-operator-source-configuration");
          const native = await openNativeTargetConfigurationResources(
            resources.configuration,
            environment,
          );
          try {
            const configuration = await resolveOwnedStandardRuntimeConfiguration({
              configuration: resources.configuration,
              resources: native,
              environment,
              context: {
                authority: selected.context.authority,
                ownerContext: operatorOwnerContextSchema.parse(selected.context.ownerContext),
                target: {
                  appId: selected.context.target.appId,
                  sessionId: selected.context.target.sessionId,
                },
              },
            });
            const canonical = await openHostedOperatorConfigurationResources(
              configuration,
              environment,
            );
            resources = canonical;
            const staging =
              await canonical.controlPlane.readPendingRealmIdentityLinkForStaging(selector);
            if (staging.publicRealm === undefined) {
              throw unavailable();
            }
            resources = { ...canonical, publicRealm: staging.publicRealm };
          } finally {
            await native.close();
          }
        }
      }
      return await createNormalActorCaptureHandler(
        createNormalActorCaptureDeploymentPorts(resources, io),
      )(request);
    } catch {
      return Response.json(
        { error: "realm_browser_session_capture_unavailable" },
        {
          headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" },
          status: 403,
        },
      );
    } finally {
      await resources?.controlPlane.close();
      if (
        initialResources !== undefined &&
        initialResources.controlPlane !== resources?.controlPlane
      ) {
        await initialResources.controlPlane.close();
      }
      if (
        initialResources !== undefined &&
        initialResources.controlPlane !== resources?.controlPlane
      ) {
        await initialResources.controlPlane.close();
      }
    }
  };
