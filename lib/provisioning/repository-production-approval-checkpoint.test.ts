/* oxlint-disable eslint/require-await -- In-memory journal operations implement asynchronous database ports. */
import type { MessageStreamEvent } from "eve/client";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createDirectProductionGrant } from "../agent/direct-production-authorization";
import { builderProvisioningJournals } from "../db/schema";
import { readRepositoryProductionApproval } from "../eve/private-repository-production-approval";
import type { OperatorOwnerContext } from "./hosted-operator-contract";
import {
  repositoryProductionApprovalInput,
  repositoryProductionApprovalReference,
} from "./repository-production-approval";
import { createRepositoryProductionApprovalCheckpoint } from "./repository-production-approval-checkpoint";
import type {
  RepositoryProductionIntent,
  RepositoryProductionScope,
} from "./repository-production-contract";

type Options = Parameters<typeof createRepositoryProductionApprovalCheckpoint>[0];
type ReadHistory = Parameters<typeof readRepositoryProductionApproval>[0]["readHistory"];
type JournalRow = Pick<
  typeof builderProvisioningJournals.$inferSelect,
  | "issuer"
  | "audience"
  | "workspaceId"
  | "ownerUserId"
  | "requestId"
  | "requestDigest"
  | "record"
  | "revision"
  | "state"
>;

const scope: RepositoryProductionScope = {
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "creator",
  },
  appId: "requests",
  repositoryId: "123",
  repositoryFullName: "withAutograph/arrusted-development",
  projectId: "project",
  organizationId: "organization",
  publicOrigin: "https://apps.example",
  environment: "production",
};
const intent: RepositoryProductionIntent = {
  sessionId: "public-session",
  sourceSha: "a".repeat(40),
  creatorRoles: [],
  storage: { kind: "none" },
};
const plan = repositoryProductionApprovalInput(scope, intent);
const owner: OperatorOwnerContext = {
  kind: "direct",
  authority: scope.authority,
  principal: { ...scope.authority, scopes: ["autograph:send"] },
  sessionId: intent.sessionId,
  adapterSessionId: "native-run",
  adapterGeneration: 1,
};
const callId = "approved-setup";
const requestId = "approval-request";
const at = "2026-11-13T00:00:00Z";

const direct = createDirectProductionGrant({
  callId,
  toolName: "apply_app_creation",
  subject: {
    version: 1,
    appId: scope.appId,
    appSpecDigest: "c".repeat(64),
    proposalDigest: "d".repeat(64),
    sessionId: owner.adapterSessionId,
    buildWorkspaceId: "workspace-build",
    authority: scope.authority,
    repositoryId: scope.repositoryId,
    repositoryFullName: "withAutograph/arrusted-development",
    installationId: "555",
    baseBranch: "main",
    storageKind: "none",
  },
});

const setupRequest: Extract<MessageStreamEvent, { type: "input.requested" }> = {
  type: "input.requested",
  meta: { at, id: "native-request-event" },
  data: {
    sequence: 1,
    stepIndex: 0,
    turnId: "turn",
    requests: [
      {
        kind: "tool-approval",
        requestId,
        prompt: "Set up this app?",
        action: {
          kind: "tool-call",
          toolName: "prepare-app-production",
          callId,
          input: repositoryProductionApprovalReference(plan),
        },
      },
    ],
  },
};
const buildRequest: typeof setupRequest = {
  ...setupRequest,
  data: {
    ...setupRequest.data,
    requests: [
      {
        kind: "tool-approval",
        requestId,
        prompt: "Build and release this app?",
        action: {
          kind: "tool-call",
          toolName: direct.toolName,
          callId,
          input: { directProduction: direct.subject },
        },
      },
    ],
  },
};
const settlement = (outcome: "approved" | "cancelled" = "approved"): MessageStreamEvent => ({
  type: "approval.settled",
  meta: { at, id: "native-settlement-event" },
  data: {
    sequence: 2,
    stepIndex: 0,
    turnId: "turn",
    requestId,
    responderPrincipalId: owner.authority.ownerUserId,
    outcome,
  },
});

const fixture = () => {
  const rows: JournalRow[] = [];
  const dialect = new PgDialect();
  const journalKind = z.object({ kind: z.string() });
  const readKey = (predicate: SQL) => {
    const { params } = dialect.sqlToQuery(predicate);
    const [issuer, audience, workspaceId, ownerUserId, rowRequestId, kind, revision] = params;
    return rows.find((row) =>
      [
        row.issuer === issuer,
        row.audience === audience,
        row.workspaceId === workspaceId,
        row.ownerUserId === ownerUserId,
        row.requestId === rowRequestId,
        journalKind.parse(row.record).kind === kind,
        revision === undefined || revision === row.revision,
      ].every(Boolean),
    );
  };
  const selectWhere = (predicate: SQL) => ({
    limit: async () => {
      const row = readKey(predicate);
      return row === undefined ? [] : [structuredClone(row)];
    },
  });
  const insert = async (value: JournalRow) => {
    const found = rows.some((row) =>
      [
        row.issuer === value.issuer,
        row.audience === value.audience,
        row.workspaceId === value.workspaceId,
        row.ownerUserId === value.ownerUserId,
        row.requestId === value.requestId,
      ].every(Boolean),
    );
    if (found) {
      return [];
    }
    rows.push(structuredClone(value));
    return [{ revision: value.revision }];
  };
  const insertValues = (value: JournalRow) => ({
    onConflictDoNothing: () => ({ returning: async () => await insert(value) }),
  });
  const update = async (predicate: SQL, change: Partial<JournalRow>) => {
    const row = readKey(predicate);
    if (row === undefined) {
      return [];
    }
    Object.assign(row, structuredClone(change));
    return [{ revision: row.revision }];
  };
  const updateSet = (change: Partial<JournalRow>) => ({
    where: (predicate: SQL) => ({ returning: async () => await update(predicate, change) }),
  });
  const journal = {
    select: () => ({
      from: (table: typeof builderProvisioningJournals) => {
        expect(table).toBe(builderProvisioningJournals);
        return { where: selectWhere };
      },
    }),
    insert: (table: typeof builderProvisioningJournals) => {
      expect(table).toBe(builderProvisioningJournals);
      return { values: insertValues };
    },
    update: (table: typeof builderProvisioningJournals) => {
      expect(table).toBe(builderProvisioningJournals);
      return { set: updateSet };
    },
  };
  // SAFETY: Only the modeled select, insert and update chains are available and each checks its bound key.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Model this checkpoint's narrow Drizzle boundary without a service or database.
  const database = journal as unknown as Options["database"];
  const assertCurrentOwner = vi.fn<Options["assertCurrentOwner"]>().mockResolvedValue();
  const checkpoint = (overrides: Partial<Omit<Options, "database">> = {}) =>
    createRepositoryProductionApprovalCheckpoint({
      database,
      owner,
      plan,
      callId,
      assertCurrentOwner,
      ...overrides,
    });
  return { checkpoint, assertCurrentOwner, rows };
};

const partialHistory = (
  events: MessageStreamEvent[],
  startIndex: number,
  nextNativeIndex: number,
) =>
  vi.fn<ReadHistory>(async (start, observe) => {
    expect(start).toBe(startIndex);
    for (const event of events) {
      observe(event);
    }
    return { complete: false, nativeTailIndex: 90, nextNativeIndex };
  });

const readApproval = async (
  checkpoint: ReturnType<typeof createRepositoryProductionApprovalCheckpoint>,
  readHistory: ReadHistory,
  assertOwner: () => Promise<void>,
  overrides: Partial<
    Pick<Parameters<typeof readRepositoryProductionApproval>[0], "directProduction" | "owner">
  > = {},
) => {
  const state = await checkpoint.read();
  return await readRepositoryProductionApproval({
    callId,
    owner,
    plan,
    observation: { state, save: checkpoint.save },
    readHistory,
    assertOwner,
    ...overrides,
  });
};

it.each(["setup", "direct Build"] as const)(
  "continues a fresh %s request from the durable cursor and requires a complete owner settlement",
  async (kind) => {
    const { checkpoint, rows, assertCurrentOwner } = fixture();
    const selected =
      kind === "setup" ? checkpoint : () => checkpoint({ directGrantDigest: direct.digest });
    const overrides =
      kind === "setup"
        ? {}
        : { directProduction: { grant: direct, logicalSessionId: owner.adapterSessionId } };
    const firstEvent = kind === "setup" ? setupRequest : buildRequest;
    await expect(
      readApproval(selected(), partialHistory([firstEvent], 0, 29), assertCurrentOwner, overrides),
    ).rejects.toMatchObject({ progressPersisted: true });
    await expect(
      readApproval(
        selected(),
        partialHistory([settlement()], 29, 74),
        assertCurrentOwner,
        overrides,
      ),
    ).rejects.toMatchObject({ progressPersisted: true });

    expect(rows.map(({ state, revision }) => ({ state, revision }))).toEqual([
      { state: "pending", revision: 2 },
    ]);
    const complete = vi.fn<ReadHistory>().mockResolvedValue({
      complete: true,
      nativeTailIndex: 90,
      nextNativeIndex: 90,
    });
    await expect(
      readApproval(selected(), complete, assertCurrentOwner, overrides),
    ).resolves.toEqual({
      approvalId: requestId,
      approvedByCallId: callId,
    });
    expect(complete).toHaveBeenCalledWith(74, expect.any(Function));
  },
);

it("preserves cancellation while restarting history after a native adapter change", async () => {
  const { checkpoint, assertCurrentOwner } = fixture();
  await expect(
    readApproval(
      checkpoint(),
      partialHistory([setupRequest, settlement("cancelled")], 0, 60),
      assertCurrentOwner,
    ),
  ).rejects.toMatchObject({ progressPersisted: true });

  const recovered = { ...owner, adapterSessionId: "recovered-native-run", adapterGeneration: 2 };
  const replay = vi.fn<ReadHistory>(async (start, observe) => {
    expect(start).toBe(0);
    observe(setupRequest);
    observe(settlement());
    return { complete: true, nativeTailIndex: 10, nextNativeIndex: 10 };
  });
  await expect(
    readApproval(checkpoint({ owner: recovered }), replay, assertCurrentOwner, {
      owner: recovered,
    }),
  ).resolves.toBeNull();
  expect(await checkpoint({ owner: recovered }).read()).toMatchObject({
    adapterSessionId: recovered.adapterSessionId,
    adapterGeneration: recovered.adapterGeneration,
    nextNativeIndex: 10,
  });
});

it("keeps Production checkpoints isolated by call, grant kind, plan and owned session", async () => {
  const { checkpoint, assertCurrentOwner } = fixture();
  await expect(
    readApproval(
      checkpoint(),
      partialHistory([setupRequest, settlement()], 0, 40),
      assertCurrentOwner,
    ),
  ).rejects.toMatchObject({ progressPersisted: true });

  const otherSession = "other-public-session";
  const otherOwner = { ...owner, sessionId: otherSession };
  const otherPlan = repositoryProductionApprovalInput(scope, {
    ...intent,
    creatorRoles: ["editor"],
  });
  await expect(checkpoint({ callId: "another-call" }).read()).resolves.toBeUndefined();
  await expect(checkpoint({ plan: otherPlan }).read()).resolves.toBeUndefined();
  await expect(
    checkpoint({
      plan: repositoryProductionApprovalInput(scope, { ...intent, sessionId: otherSession }),
      owner: otherOwner,
    }).read(),
  ).resolves.toBeUndefined();

  const complete = vi.fn<ReadHistory>().mockResolvedValue({
    complete: true,
    nativeTailIndex: 90,
    nextNativeIndex: 90,
  });
  await expect(
    readApproval(checkpoint({ directGrantDigest: direct.digest }), complete, assertCurrentOwner, {
      directProduction: { grant: direct, logicalSessionId: owner.adapterSessionId },
    }),
  ).resolves.toBeNull();
  expect(complete).toHaveBeenCalledWith(0, expect.any(Function));
  expect(await checkpoint().read()).toMatchObject({ nextNativeIndex: 40 });
});

it("does not persist approval progress if the canonical owner is lost during the history read", async () => {
  const { checkpoint, rows, assertCurrentOwner } = fixture();
  const readHistory = partialHistory([setupRequest, settlement()], 0, 40);
  readHistory.mockImplementationOnce(async (_start, observe) => {
    observe(setupRequest);
    observe(settlement());
    assertCurrentOwner.mockRejectedValue(new Error("owner-revoked"));
    return { complete: false, nativeTailIndex: 90, nextNativeIndex: 40 };
  });
  await expect(readApproval(checkpoint(), readHistory, assertCurrentOwner)).rejects.toThrow(
    "owner-revoked",
  );
  expect(rows).toEqual([]);
});
