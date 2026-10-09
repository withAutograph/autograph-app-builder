import { and, eq } from "drizzle-orm";
import { agentSessions } from "../db/schema";
import { createPostgresWorkspaceMembership } from "../eve/postgres-workspace-membership";
import { z } from "zod";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { createLocalSourceReviewJournal } from "./local-source-review-journal";
import { createPostgresSourceReviewJournal } from "./postgres-source-review-journal";
import type { SourceReviewJournal } from "./product-source-review-journal";

/** The runtime selects storage; tool arguments cannot select roots, owners, or profiles. */
export const sourceReviewJournalForSession = async (input: {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The exact forwarded session authentication envelope is validated here.
  sessionAuth: unknown;
  sessionId: string;
}): Promise<SourceReviewJournal> => {
  if (!input.sessionId) {
    throw new Error("Source review session is unavailable.");
  }
  const authority = await readLocalOperatorArtifactAuthority();
  if (authority === undefined) {
    exactForwardedSessionAuthority(input.sessionAuth);
    if (process.env.DATABASE_URL === undefined || process.env.DATABASE_URL.length === 0) {
      throw new Error(
        "Durable source review storage is unavailable. Configure the hosted database before retrying.",
      );
    }
    const db = openHostedPostgresDatabase(process.env.DATABASE_URL);
    return createPostgresSourceReviewJournal({
      ...input,
      async assertCurrentOwner() {
        const { principal } = exactForwardedSessionAuthority(input.sessionAuth);
        if (
          !(await createPostgresWorkspaceMembership(db).isMember({
            principal,
            workspaceId: principal.workspaceId,
          }))
        ) {
          throw new Error("Source review membership is unavailable.");
        }
        const rows = await db
          .select({ sessionId: agentSessions.sessionId })
          .from(agentSessions)
          .where(
            and(
              eq(agentSessions.issuer, principal.issuer),
              eq(agentSessions.audience, principal.audience),
              eq(agentSessions.workspaceId, principal.workspaceId),
              eq(agentSessions.ownerUserId, principal.ownerUserId),
              eq(agentSessions.adapterSessionId, input.sessionId),
            ),
          )
          .limit(2);
        if (rows.length !== 1) {
          throw new Error("Source review session ownership is unavailable.");
        }
      },
      db,
    });
  }
  // Authenticated local web sessions retain their principal; native local sessions bind to the verified OS owner.
  const localPrincipal = () =>
    input.sessionAuth === undefined ||
    input.sessionAuth === null ||
    z.strictObject({}).safeParse(input.sessionAuth).success
      ? null
      : exactForwardedSessionAuthority(input.sessionAuth).authority;
  const principal = localPrincipal();
  const expected = JSON.stringify(authority);
  return await createLocalSourceReviewJournal({
    async assertCurrentOwner() {
      if (JSON.stringify(localPrincipal()) !== JSON.stringify(principal)) {
        throw new Error("Source review local principal changed.");
      }
      if (JSON.stringify(await readLocalOperatorArtifactAuthority()) !== expected) {
        throw new Error("Source review journal belongs to another local owner.");
      }
    },
    ownerScope: JSON.stringify({ ownerUid: authority.ownerUid, principal }),
    sessionId: input.sessionId,
    stateRoot: authority.stateRoot,
  });
};
