import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import {
  parseHostedTenantExportPlanForOwner,
  tenantExportJournalRecordSchema,
} from "./hosted-operator-export-contract";
import type {
  TenantExportJournalRecord,
  TenantExportWorkerInput,
} from "./hosted-operator-export-contract";
import {
  inspectTenantExportCompletion,
  streamTenantExportBytes,
} from "./hosted-operator-export-artifacts";
import {
  operatorArtifactUnavailable,
  createPostgresOperatorArtifactReader,
} from "./hosted-operator-artifact-store";
import type {
  OperatorArtifactContext,
  OperatorArtifactStore,
} from "./hosted-operator-artifact-store";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { getPreviewOAuthDeploymentSession } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import { openHostedPostgresDatabase } from "../db/hosted-postgres";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { hostedPrincipalSchema } from "../eve/hosted-auth";
import { createTenantExportCompletionLookup } from "./postgres-hosted-operator-export-journal";

type Authority = HostedOperatorContext["authority"];
export interface TenantExportReaderPorts {
  authenticate: (request: Request) => Promise<Authority | undefined>;
  readCompletion: (input: {
    exportId: string;
    authority: Authority;
  }) => Promise<TenantExportJournalRecord | null>;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
  store: Pick<OperatorArtifactStore, "read">;
}
const privateHeaders = {
  "cache-control": "private, no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};
const unavailable = () =>
  new Response("Export is unavailable.", { status: 404, headers: privateHeaders });
const workerFor = (record: TenantExportJournalRecord): TenantExportWorkerInput => {
  const completion = record.completion;
  if (!completion) {
    throw operatorArtifactUnavailable();
  }
  return {
    version: 1,
    kind: "tenant-export-worker",
    exportId: record.requestId,
    attemptId: completion.attemptId,
    snapshotId: completion.snapshotId,
    planDigest: record.planDigest,
    scope: record.plan.scope,
    resource: record.plan.resource,
    release: record.plan.release,
    selection: record.plan.selection,
    format: record.plan.format,
  };
};
const responseBody = (iterator: AsyncIterator<Uint8Array>) =>
  new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done === true) {
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch {
        controller.error(operatorArtifactUnavailable());
        await iterator.return?.();
      }
    },
    async cancel() {
      await iterator.return?.();
    },
  });

/** Current owner authority, never prepare/effect authority, controls retained downloads. */
export const createTenantExportReader =
  (ports: TenantExportReaderPorts) =>
  async (request: Request, input: { exportId: string; member?: string[] }): Promise<Response> => {
    try {
      const exportId = z.uuid().parse(input.exportId);
      if (input.member && input.member.length !== 1) {
        return unavailable();
      }
      const authority = await ports.authenticate(request);
      if (!authority) {
        return new Response("Sign in to download this export.", {
          status: 401,
          headers: privateHeaders,
        });
      }
      const rawRecord = await ports.readCompletion({ exportId, authority });
      if (!rawRecord) {
        return unavailable();
      }
      const record = tenantExportJournalRecordSchema.parse(rawRecord);
      if (
        record.requestId !== exportId ||
        record.state !== "complete" ||
        !record.completion ||
        !record.approval
      ) {
        return unavailable();
      }
      const context: OperatorArtifactContext = {
        authority,
        target: { appId: record.target.appId, sessionId: record.target.sessionId },
      };
      parseHostedTenantExportPlanForOwner(record.plan, { authority, target: context.target });
      const assertCurrent = () => ports.assertCurrentOwner(context);
      await assertCurrent();
      const worker = workerFor(record);
      const inspection = await inspectTenantExportCompletion({
        ...ports,
        context,
        worker,
      });
      if (
        inspection.status !== "complete" ||
        !isDeepStrictEqual(inspection.completion, record.completion)
      ) {
        return unavailable();
      }
      const manifest = inspection.manifest;
      const name = input.member?.at(0);
      if (name === undefined) {
        const path = `/api/hosted-operator/exports/${exportId}`;
        await assertCurrent();
        return Response.json(
          {
            exportId,
            files: [record.completion.manifest, ...manifest.files].map((file) => ({
              name: file.name,
              byteLength: file.byteLength,
              sha256: file.sha256,
              downloadPath: `${path}/${file.name}`,
            })),
          },
          { headers: privateHeaders },
        );
      }
      const file =
        name === "manifest.json"
          ? record.completion.manifest
          : manifest.files.find((candidate) => candidate.name === name);
      if (!file) {
        return unavailable();
      }
      const members = file.kind === "manifest" ? [file] : file.chunks;
      const bytes = async function* bytes() {
        for (const chunk of members) {
          yield* streamTenantExportBytes({ ...ports, ...chunk, context });
        }
      };
      await assertCurrent();
      return new Response(
        file.kind === "manifest" ? Buffer.from(inspection.manifestBytes) : responseBody(bytes()),
        {
          headers: {
            ...privateHeaders,
            "content-type": file.kind === "manifest" ? "application/json" : "application/x-ndjson",
            "content-disposition": `attachment; filename="${file.name}"`,
            "content-length": file.byteLength,
          },
        },
      );
    } catch {
      return unavailable();
    }
  };

/** Production adapter has only session, workspace, canonical session and SELECT ports. */
export const createTenantExportDownloadDeploymentHandler = (
  environment: NodeJS.ProcessEnv = process.env,
) => {
  let portsForRequest: ((request: Request) => TenantExportReaderPorts) | undefined;
  return async (request: Request, input: { exportId: string; member?: string[] }) => {
    if (!portsForRequest) {
      const config = readPreviewOAuthRuntimeConfig(environment);
      const database = openHostedPostgresDatabase(config.databaseUrl);
      const membership = createPostgresPreviewOrganizationAuthority(database, {
        issuer: config.issuer,
        audience: config.resource,
      });
      const sessions = createPostgresHostedEveStore(database);
      const authenticate = async (currentRequest: Request): Promise<Authority | undefined> => {
        if (new URL(currentRequest.url).origin !== new URL(config.issuer).origin) {
          return undefined;
        }
        const session = await getPreviewOAuthDeploymentSession({
          environment,
          headers: currentRequest.headers,
        });
        if (session?.user.id === undefined) {
          return undefined;
        }
        const workspaceId = await membership.activeWorkspaceForUser({
          issuer: config.issuer,
          audience: config.resource,
          ownerUserId: session.user.id,
        });
        return workspaceId === undefined
          ? undefined
          : {
              issuer: config.issuer,
              audience: config.resource,
              ownerUserId: session.user.id,
              workspaceId,
            };
      };
      portsForRequest = (currentRequest: Request): TenantExportReaderPorts => {
        const assertAuthority = async (authority: Authority) => {
          const current = await authenticate(currentRequest);
          if (!isDeepStrictEqual(current, authority)) {
            throw operatorArtifactUnavailable();
          }
        };
        const assertCurrentOwner = async (context: OperatorArtifactContext) => {
          const authority = await authenticate(currentRequest);
          if (!authority || !isDeepStrictEqual(authority, context.authority)) {
            throw operatorArtifactUnavailable();
          }
          const principal = hostedPrincipalSchema.parse({
            ...authority,
            scopes: ["autograph:get"],
          });
          const session = await sessions.getSession(principal, context.target.sessionId);
          if (!session || session.version !== 2 || session.appId !== context.target.appId) {
            throw operatorArtifactUnavailable();
          }
        };
        return {
          authenticate,
          readCompletion: createTenantExportCompletionLookup({
            database,
            assertOwner: assertAuthority,
          }),
          assertCurrentOwner,
          store: createPostgresOperatorArtifactReader({ database, assertCurrentOwner }),
        };
      };
    }
    return await createTenantExportReader(portsForRequest(request))(request, input);
  };
};
