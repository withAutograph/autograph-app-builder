/* oxlint-disable eslint/no-bitwise -- O_NOFOLLOW flags and owner-only file permissions require bitmask operations. */
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Existing typed Drizzle stores use the complete schema namespace.
import * as databaseSchema from "../db/schema";
import postgres from "postgres";
import { z } from "zod";
import { hostedTaskPostgresOptions } from "../db/postgres-connection-policy";
import { readPrivateDatabaseUrl } from "../db/private-database-url";
import { createPostgresVercelTokenKeyCustodyStore } from "./postgres-vercel-token-key-custody";
import { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";
import { createHostedOperatorConsentOwner } from "./hosted-operator-consent-owner";
import { custodyActorDigest, custodyDigest } from "./vercel-token-key-custody";
import { custodySetupConfigurationSchema } from "./vercel-token-key-custody-deployment";
import {
  custodyEnrollmentRequestSchema,
  custodyEnrollmentDigest,
  enrollCustodyGrant,
  custodyRetirementRequestSchema,
  custodyRetirementDigest,
  retireCustodyReservation,
} from "./vercel-token-key-custody-enrollment";

const packetSchema = z.strictObject({
  confirmationDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  request: z.union([custodyEnrollmentRequestSchema, custodyRetirementRequestSchema]),
  setup: custodySetupConfigurationSchema,
});
const reviewedDigestRequired = "The reviewed custody digest is required.";
const privatePacket = async (filename: string) => {
  if (!path.isAbsolute(filename)) {
    throw new Error("Custody setup requires an absolute private request path.");
  }
  if ((await realpath(filename)) !== filename) {
    throw new Error("Custody setup requires a canonical request file.");
  }
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    // oxlint-disable-next-line sonarjs/expression-complexity -- The private file must satisfy every independent ownership and size condition.
    if (
      [
        !metadata.isFile(),
        metadata.uid !== process.getuid?.(),
        (metadata.mode & 0o077) !== 0,
        metadata.size < 1,
        metadata.size > 65_536,
      ].some(Boolean)
    ) {
      throw new Error("Custody setup requires an owner-only bounded regular request file.");
    }
    const buffer = Buffer.alloc(65_537);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 65_536) {
      throw new Error("Custody setup request is too large.");
    }
    return packetSchema.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf-8")));
  } finally {
    await handle.close();
  }
};
const args = process.argv.slice(2);
const [mode] = args;
const planMode = mode === "plan" || mode === "retire-plan";
const mutationMode = mode === "enroll" || mode === "retire";
// oxlint-disable-next-line sonarjs/expression-complexity -- Only the two exact documented administrator command forms are accepted.
if (
  [
    !(planMode || mutationMode),
    args[1] !== "--request-file",
    planMode
      ? args.length !== 3
      : [args.length !== 5, args[3] !== "--database-url-fd", args[4] !== "0"].some(Boolean),
  ].some(Boolean)
) {
  throw new Error(
    "Expected plan|retire-plan --request-file PATH or enroll|retire --request-file PATH --database-url-fd 0.",
  );
}
try {
  const packet = await privatePacket(args[2]);
  const { setup, request } = packet;
  const { record } = request;
  // oxlint-disable-next-line sonarjs/expression-complexity -- The private packet must bind stable setup and the exact reviewed grant.
  if (
    [
      setup.operationRef !== record.plan.operationRef,
      setup.grantRef !== record.grantRef,
      setup.capturedOwner.sessionId !== record.plan.ownerSessionId,
      custodyActorDigest(setup.capturedOwner.authority) !== record.plan.actorAuthorityDigest,
      setup.source.workload.projectId !== record.plan.source.projectId,
      setup.source.workload.ownerId !== record.plan.source.teamId,
      setup.recipient.workload.projectId !== record.plan.destination.projectId,
      setup.recipient.workload.ownerId !== record.plan.destination.teamId,
    ].some(Boolean)
  ) {
    throw new Error("Custody setup identity mismatch.");
  }
  let serializedOutput: string;
  if (mode === "plan") {
    const enrollment = custodyEnrollmentRequestSchema.parse(request);
    serializedOutput = JSON.stringify({
      approvalRef: record.approvalRef,
      confirmationDigest: custodyEnrollmentDigest(enrollment),
      grantDigest: record.grantDigest,
      grantRef: record.grantRef,
      operationRef: record.plan.operationRef,
      planDigest: record.planDigest,
    });
  } else if (mode === "retire-plan") {
    const retirement = custodyRetirementRequestSchema.parse(request);
    serializedOutput = JSON.stringify({
      confirmationDigest: custodyRetirementDigest(retirement),
      expectedRevision: retirement.expectedRevision,
      operationRef: record.plan.operationRef,
      planDigest: record.planDigest,
      recordDigest: custodyDigest(record),
    });
  } else {
    if (packet.confirmationDigest === undefined) {
      throw new Error(reviewedDigestRequired);
    }
    if (
      mode === "enroll" &&
      packet.confirmationDigest !==
        custodyEnrollmentDigest(custodyEnrollmentRequestSchema.parse(request))
    ) {
      throw new Error(reviewedDigestRequired);
    }
    if (
      mode === "retire" &&
      packet.confirmationDigest !==
        custodyRetirementDigest(custodyRetirementRequestSchema.parse(request))
    ) {
      throw new Error(reviewedDigestRequired);
    }
    const databaseUrl = readPrivateDatabaseUrl(0);
    const client = postgres(databaseUrl, hostedTaskPostgresOptions);
    try {
      const owner = createHostedOperatorConsentOwner(setup.source.workload, {
        BETTER_AUTH_URL: setup.capturedOwner.authority.issuer,
        DATABASE_URL: databaseUrl,
        MCP_RESOURCE_URL: setup.capturedOwner.authority.audience,
      });
      const assertOriginalOwner = async () => {
        await owner.assertCurrent({
          authority: setup.capturedOwner.authority,
          ownerContext: setup.capturedOwner,
        });
      };
      const physicalLease = createPostgresPhysicalResourceLease({
        openLockClient: (onclose) =>
          postgres(databaseUrl, { ...hostedTaskPostgresOptions, max: 1, onclose }),
      });
      const store = createPostgresVercelTokenKeyCustodyStore(
        drizzle(client, { schema: databaseSchema }),
      );
      const receipt =
        mode === "enroll"
          ? await enrollCustodyGrant({
              assertOriginalOwner,
              confirmationDigest: packet.confirmationDigest,
              physicalLease,
              request: custodyEnrollmentRequestSchema.parse(request),
              store,
            })
          : await retireCustodyReservation({
              assertOriginalOwner,
              confirmationDigest: packet.confirmationDigest,
              physicalLease,
              request: custodyRetirementRequestSchema.parse(request),
              store,
            });
      serializedOutput = JSON.stringify(receipt);
    } finally {
      await client.end({ timeout: 5 });
    }
  }
  process.stdout.write(`${serializedOutput}\n`);
} catch {
  // No request, SQL URL, provider body or exception data becomes process output.
  process.stderr.write("Custody setup is unavailable or requires reconciliation.\n");
  process.exitCode = 1;
}
