import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  completedParticipantBootstrapSchema,
  inspectCompletedParticipantBootstrap,
} from "./hosted-operator-participant-bootstrap";
import type { CompletedParticipantBootstrap } from "./hosted-operator-participant-bootstrap";
/* oxlint-disable eslint/no-await-in-loop -- Bounded response reading cancels immediately at the byte limit. */
import { Cookie, CookieJar } from "tough-cookie";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";
import {
  HostedOperatorError,
  hostedOperatorOwnedOrganizationSpecSchema,
} from "./hosted-operator-contract";
import type { HostedOperatorOwnedOrganizationSpec } from "./hosted-operator-contract";
import { reportOperatorNormalActorProofFailure } from "./hosted-operator-consent-diagnostic";
import type { OperatorNormalActorProofFailure } from "./hosted-operator-consent-diagnostic";
import { readVerifiedRealmAccess } from "./hosted-operator-auth-identity";
import type { realmPhysicalResourceSchema } from "./hosted-operator-auth-identity";
import { createNormalActorJournal } from "./hosted-operator-normal-actor-journal";
import type {
  NormalActorJournalPorts,
  NormalActorAccountPreparation,
  NormalActorOrganizationProofBinding,
  NormalActorOrganizationProof,
} from "./hosted-operator-normal-actor-journal";
import type { NormalActorOperationsDependencies } from "./hosted-operator-normal-actor-operations";
import { createHostedOperatorNormalAuthClient } from "./hosted-operator-normal-auth-client";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
import type { NormalBrowserStorageState } from "./hosted-operator-normal-actor-program";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type {
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "./hosted-operator-artifact-store";

export interface NormalActorRealmProofBinding extends Omit<
  NormalActorOrganizationProofBinding,
  "browserOrigin"
> {
  builderCallbackOrigin: string;
  resource: z.infer<typeof realmPhysicalResourceSchema>;
  getKey: JWTVerifyGetKey;
  readback: (request: Request) => Promise<Response>;
  transportSource: HostedOperatorOwnedOrganizationSpec["identityVerification"]["transportSource"];
  bootstrap?: CompletedParticipantBootstrap;
  assertBootstrapCurrent?: () => Promise<void>;
}
export interface NormalActorProofDependencies {
  journalPorts: NormalActorJournalPorts;
  assertPlanningAuthorized: (context: HostedOperatorContext) => Promise<void>;
  normalRealmFetch: NormalActorOperationsDependencies["normalRealmFetch"];
  resolveRealmBinding: (input: {
    context: HostedOperatorContext;
    preparation: NormalActorAccountPreparation;
  }) => Promise<NormalActorRealmProofBinding>;
  ownedArtifacts: (
    context: HostedOperatorContext,
  ) => Promise<{ context: OperatorArtifactContext; store: OperatorArtifactStore }>;
}
const unavailable = () => new HostedOperatorError("auth_identity_required");
const mismatch = () => new HostedOperatorError("resource_mismatch");
const httpsOrigin = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && url.origin === value && !url.username && !url.password;
});
const proofSchema = z
  .string()
  .min(1)
  .max(16_384)
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const cookieHeader = (storage: NormalBrowserStorageState, origin: string, path: string) => {
  const jar = new CookieJar(undefined, {
    prefixSecurity: "strict",
    rejectPublicSuffixes: true,
    allowSpecialUseDomain: false,
  });
  for (const cookie of storage.cookies) {
    const domain = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
    jar.setCookieSync(
      new Cookie({
        key: cookie.name,
        value: cookie.value,
        domain,
        path: cookie.path,
        hostOnly: !cookie.domain.startsWith("."),
        expires: cookie.expires === -1 ? "Infinity" : new Date(cookie.expires * 1000),
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        sameSite: cookie.sameSite.toLowerCase(),
      }),
      new URL(cookie.path, origin).href,
    );
  }
  return jar.getCookieStringSync(new URL(path, origin).href, { sameSiteContext: "strict" });
};
const boundedProofResponse = async (response: Response) => {
  if (response.body === null) {
    throw unavailable();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      break;
    }
    size += next.value.byteLength;
    if (size > 64 * 1024) {
      await reader.cancel();
      throw unavailable();
    }
    chunks.push(next.value);
  }
  try {
    const result = z
      .strictObject({ version: z.literal(1), proof: proofSchema })
      .parse(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
    return result.proof;
  } catch {
    throw unavailable();
  }
};

type OwnedArtifacts = Awaited<ReturnType<NormalActorProofDependencies["ownedArtifacts"]>>;
const readProof = async ({
  record,
  nonce,
  artifacts,
  context,
  fetch,
  storageState,
  origin,
  assertCurrent,
  observe,
}: {
  record: NormalActorOrganizationProof;
  nonce?: string;
  artifacts: OwnedArtifacts;
  context: HostedOperatorContext;
  fetch: typeof globalThis.fetch;
  storageState: NormalBrowserStorageState;
  origin: string;
  assertCurrent: () => Promise<void>;
  observe: (failure: OperatorNormalActorProofFailure) => void;
}): Promise<string> => {
  let proof: string;
  if (record.link.consumedAt === undefined) {
    observe({ stage: "proof_request" });
    if (nonce === undefined) {
      throw unavailable();
    }
    const path = "/api/auth/platform/operator-link";
    const url = new URL(path, origin);
    const body = new URLSearchParams({
      nonce,
      ownerSessionId: context.target.sessionId,
      bootstrapPlanDigest: record.link.bootstrapPlanDigest,
      authResourceId: record.link.authResourceId,
    });
    // Browser-session correlation would invoke the separate human capture callback; this nonce is already bound to the approved retained organization candidate.
    const cookie = cookieHeader(storageState, origin, path);
    observe({ stage: "proof_request", cookiePresent: cookie !== "" });
    if (cookie === "") {
      throw unavailable();
    }
    await assertCurrent();
    const response = await fetch(url, {
      method: "POST",
      body,
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/vnd.realm-operator-proof+json",
        cookie,
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(20_000),
    });
    const responseFacts = {
      cookiePresent: cookie !== "",
      httpStatus: response.status,
      redirected: response.redirected,
      contentTypeValid:
        response.headers
          .get("content-type")
          ?.startsWith("application/vnd.realm-operator-proof+json") === true,
    };
    observe({ stage: "proof_response", ...responseFacts });
    if (
      ![
        response.status === 200,
        !response.redirected,
        response.url === "" || new URL(response.url).origin === origin,
        response.headers
          .get("content-type")
          ?.startsWith("application/vnd.realm-operator-proof+json") === true,
      ].every(Boolean)
    ) {
      throw unavailable();
    }
    observe({ stage: "proof_decode", ...responseFacts });
    proof = await boundedProofResponse(response);
  } else {
    observe({ stage: "proof_artifact_read" });
    const { proofRef, proofSha256 } = record.link;
    if (proofRef === undefined || proofSha256 === undefined) {
      throw unavailable();
    }
    const content = await artifacts.store.read(artifacts.context, proofRef, 0);
    if (content === undefined) {
      throw unavailable();
    }
    if (content.length > 24 * 1024) {
      throw unavailable();
    }
    const bytes = Buffer.from(content, "base64");
    proof = proofSchema.parse(bytes.toString("utf-8"));
    if (
      bytes.length > 16_384 ||
      bytes.toString("base64") !== content ||
      digest(proof) !== proofSha256 ||
      proofRef !==
        `_protected-operator/artifacts/realm-identity-proof/${context.target.appId}/${proofSha256}`
    ) {
      throw mismatch();
    }
  }
  return proof;
};
type CollectorInput = Parameters<
  NormalActorOperationsDependencies["collectOrganizationOwnerProof"]
>[0];
type RetainedActors = NonNullable<
  Awaited<ReturnType<ReturnType<typeof createNormalActorJournal>["read"]>>
>;
const selectedOwner = (input: CollectorInput, retained: RetainedActors) => {
  const { preparation, state } = retained;
  const organization = preparation.program.organizations.find(
    (entry) => entry.organizationId === input.organizationId,
  );
  const candidate = state.organizationSessions?.find(
    (entry) =>
      entry.organizationId === input.organizationId &&
      entry.actorKey === organization?.ownerActorKey,
  );
  const actor = preparation.program.actors.find(
    (entry) => entry.actorKey === organization?.ownerActorKey,
  );
  if (
    input.plan.normalActorProgram === undefined ||
    normalActorProgramDigest(input.plan.normalActorProgram) !== preparation.programDigest
  ) {
    throw mismatch();
  }
  const same = [
    input.preparation.accountOperationRef === preparation.accountOperationRef,
    input.preparation.accountApprovalId === preparation.accountApprovalId,
    input.preparation.accountPlanDigest === preparation.accountPlanDigest,
    input.preparation.programDigest === preparation.programDigest,
    input.owner.actorId === candidate?.session.actorId,
    input.owner.realmSessionId === candidate?.session.realmSessionId,
  ];
  if (
    organization === undefined ||
    candidate === undefined ||
    actor === undefined ||
    !same.every(Boolean)
  ) {
    throw mismatch();
  }
  return { organization, candidate, actor };
};
const assertRealmBinding = (
  input: HostedOperatorContext,
  preparation: NormalActorAccountPreparation,
  binding: NormalActorRealmProofBinding,
) => {
  httpsOrigin.parse(binding.builderCallbackOrigin);
  if (
    binding.issuer !== preparation.program.origin ||
    binding.authResourceId !== preparation.accountPlan.authDatabase.resourceId
  ) {
    throw mismatch();
  }
  if (
    ![
      binding.resource.database === preparation.accountPlan.authDatabase.database,
      binding.resource.hostname === preparation.accountPlan.neon.endpoint,
      binding.resource.runtimeRole === preparation.accountPlan.authDatabase.runtimeRole,
      binding.resource.migratorRole === preparation.accountPlan.authDatabase.migratorRole,
      binding.resource.environment === input.target.environment,
      binding.resource.neon?.projectId === preparation.accountPlan.neon.projectId,
      binding.resource.neon?.branchId === preparation.accountPlan.neon.branchId,
      binding.resource.port === 5432,
      binding.resource.schema === "public",
      binding.endpointOrigin ===
        (binding.bootstrap?.candidate.origin ??
          preparation.accountPlan.deploymentBoundary?.verification.gatewayOrigin),
      binding.transportSource.ownerId === preparation.accountPlan.deploymentBoundary?.teamId,
      binding.transportSource.projectId ===
        preparation.accountPlan.deploymentBoundary?.operator.projectId,
      binding.transportSource.environment ===
        preparation.accountPlan.deploymentBoundary?.operator.environment,
    ].every(Boolean)
  ) {
    throw mismatch();
  }
};
/** Private normal owner-proof collection; no fresh login, HTML execution, or callback navigation. */
export const createHostedOperatorNormalActorProofCollector = (
  deps: NormalActorProofDependencies,
): NormalActorOperationsDependencies["collectOrganizationOwnerProof"] => {
  const journal = createNormalActorJournal(deps.journalPorts);
  return async (input) => {
    let failure: OperatorNormalActorProofFailure = { stage: "authorization" };
    const observe = (value: OperatorNormalActorProofFailure) => {
      failure = value;
    };
    try {
      let assertBootstrapCurrent: (() => Promise<void>) | undefined;
      const assertCurrent = async () => {
        await deps.assertPlanningAuthorized(input);
        await assertBootstrapCurrent?.();
      };
      await assertCurrent();
      observe({ stage: "journal_read" });
      const retained = await journal.read(input);
      if (retained === undefined) {
        throw unavailable();
      }
      const { preparation } = retained;
      const { organization, candidate, actor } = selectedOwner(input, retained);
      observe({ stage: "owner_session" });
      const fetch = await deps.normalRealmFetch({
        context: input,
        origin: preparation.program.origin,
      });
      const normal = createHostedOperatorNormalAuthClient({
        origin: preparation.program.origin,
        storageState: candidate.storageState,
        fetch,
      });
      const session = await normal.getSession();
      if (
        session === null ||
        ![
          session.actorId === candidate.session.actorId,
          session.sessionId === candidate.session.realmSessionId,
          session.email.toLowerCase() === actor.email.toLowerCase(),
          Date.parse(session.expiresAt) > deps.journalPorts.now(),
        ].every(Boolean)
      ) {
        throw unavailable();
      }
      observe({ stage: "realm_binding" });
      const binding = await deps.resolveRealmBinding({ context: input, preparation });
      if (binding.bootstrap !== undefined) {
        const bootstrap = completedParticipantBootstrapSchema.parse(binding.bootstrap);
        assertBootstrapCurrent = binding.assertBootstrapCurrent;
        if (assertBootstrapCurrent === undefined) {
          throw mismatch();
        }
        await assertCurrent();
        const row = await deps.journalPorts.store.read(input);
        if (
          !isDeepStrictEqual(
            inspectCompletedParticipantBootstrap(bootstrap.auth.plan, row?.record),
            bootstrap,
          )
        ) {
          throw mismatch();
        }
        await assertCurrent();
      }
      assertRealmBinding(input, preparation, binding);
      observe({ stage: "proof_preparation" });
      const pending = await journal.prepareOrganizationProof(input, {
        organizationId: organization.organizationId,
        ownerActorKey: organization.ownerActorKey,
        owner: candidate.session,
        ...(binding.bootstrap === undefined || assertBootstrapCurrent === undefined
          ? {}
          : { bootstrap: binding.bootstrap, assertBootstrapCurrent }),
        binding: {
          audience: binding.audience,
          authResourceId: binding.authResourceId,
          bootstrapPlanDigest: binding.bootstrapPlanDigest,
          browserOrigin: preparation.program.origin,
          endpointOrigin: binding.endpointOrigin,
          issuer: binding.issuer,
          transportSource: binding.transportSource,
        },
      });
      observe({ stage: "artifact_context" });
      const artifacts = await deps.ownedArtifacts(input);
      if ("kind" in artifacts.context.authority) {
        throw mismatch();
      }
      if (
        ![
          artifacts.context.authority.issuer === input.authority.issuer,
          artifacts.context.authority.audience === input.authority.audience,
          artifacts.context.authority.ownerUserId === input.authority.ownerUserId,
          artifacts.context.authority.workspaceId === input.authority.workspaceId,
          artifacts.context.target.appId === input.target.appId,
          artifacts.context.target.sessionId === input.target.sessionId,
        ].every(Boolean)
      ) {
        throw mismatch();
      }
      const proof = await readProof({
        record: pending.record,
        nonce: pending.nonce,
        artifacts,
        context: input,
        fetch,
        storageState: normal.exportStorageState(),
        origin: preparation.program.origin,
        assertCurrent,
        observe,
      });
      observe({ stage: "proof_verify" });
      const verified = await readVerifiedRealmAccess({
        assertCurrent,
        pending: pending.record.link,
        nonce: pending.nonce,
        proof,
        getKey: binding.getKey,
        resource: binding.resource,
        transportOrigin: binding.endpointOrigin,
        readback: async (request) => {
          observe({ stage: "proof_readback_request" });
          const response = await binding.readback(request);
          observe({
            stage: "proof_readback_response",
            httpStatus: response.status,
            redirected: response.redirected,
          });
          return response;
        },
      });
      if (
        verified.identity.actorId !== candidate.session.actorId ||
        verified.identity.sessionId !== candidate.session.realmSessionId ||
        verified.identity.organizationId !== null
      ) {
        throw mismatch();
      }
      observe({ stage: "proof_persistence" });
      let captured = pending.record;
      if (captured.link.consumedAt === undefined) {
        const proofSha256 = digest(proof);
        const proofRef = `_protected-operator/artifacts/realm-identity-proof/${input.target.appId}/${proofSha256}`;
        await assertCurrent();
        await artifacts.store.put(artifacts.context, {
          artifactRef: proofRef,
          chunkIndex: 0,
          content: Buffer.from(proof, "utf-8").toString("base64"),
        });
        const readback = await artifacts.store.read(artifacts.context, proofRef, 0);
        if (readback !== Buffer.from(proof, "utf-8").toString("base64")) {
          throw mismatch();
        }
        captured = await journal.completeOrganizationProof(input, {
          organizationId: organization.organizationId,
          nonceSha256: captured.link.nonceSha256,
          proofRef,
          proofSha256,
          actorId: verified.identity.actorId,
          realmSessionId: verified.identity.sessionId,
          capturedAt: new Date(deps.journalPorts.now()).toISOString(),
        });
      }
      await assertCurrent();
      observe({ stage: "result" });
      return hostedOperatorOwnedOrganizationSpecSchema.parse({
        kind: "create-owned-organization",
        organizationId: organization.organizationId,
        name: organization.name,
        slug: organization.slug,
        actorId: verified.identity.actorId,
        bootstrapPlanDigest: captured.link.bootstrapPlanDigest,
        identityCapture: {
          capturedAt: captured.link.consumedAt,
          realmSessionId: verified.identity.sessionId,
        },
        identityNonceSha256: captured.link.nonceSha256,
        identityProof: { reference: captured.link.proofRef, sha256: captured.link.proofSha256 },
        identityVerification: {
          audience: captured.link.audience,
          issuer: captured.link.issuer,
          jwksUrl: `${captured.link.endpointOrigin}/_platform/jwks.json`,
          transportSource: captured.transportSource,
        },
      });
    } catch (error) {
      reportOperatorNormalActorProofFailure(input.target.sessionId, failure, error);
      if (error instanceof HostedOperatorError) {
        throw error;
      }
      // Cookie, server HTML, JWT, native responses and encryption failures stay private.
      throw unavailable();
    }
  };
};
