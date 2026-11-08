/* oxlint-disable sonarjs/no-nested-functions -- The nested object faithfully represents the read-only Drizzle selection chain, with no mutation port. */
import { describe, expect, it, vi } from "vitest";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  captureFixture,
  context,
  requiredFixture,
} from "./hosted-operator-unapproved-app-successor.test-support";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import { readPublicReleasePreparedRuntime } from "./public-release-readiness";

const bootstrap = () => {
  const { record } = captureFixture();
  const auth = requiredFixture(record.retainedAuth);
  const operator = requiredFixture(record.operator);
  return hostedRuntimeJournalRecordSchema.parse({
    ...record,
    approvedByCallId: auth.approvedByCallId,
    operator: {
      ...operator,
      plan: auth.plan,
      planDigest: auth.planDigest,
      operationRef: auth.operationRef,
      approvalId: auth.approvalId,
      authPreparation: auth.authPreparation,
      receipts: auth.receipts,
    },
  });
};
const read = (records: ReturnType<typeof bootstrap>[]) => {
  const select = () => ({
    from: () => ({
      where: () => ({ limit: () => Promise.resolve(records.map((record) => ({ record }))) }),
    }),
  });
  // SAFETY: The test database implements only the exact read-only Drizzle chain used by this reader; no writes or effects are available.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Bounded read-chain fixture exercises actual journal schemas and stage classification.
  const database = { select } as unknown as ReturnType<typeof openHostedPostgresDatabase>;
  return readPublicReleasePreparedRuntime({
    database,
    owner: operatorOwnerContextSchema.parse(context.ownerContext),
    target: context.target,
    assertCurrentOwner: vi.fn<() => Promise<void>>().mockResolvedValue(),
  });
};
describe("public bootstrap runtime staging", () => {
  it("accepts actual completed Auth bootstrap custody without requiring app install or appready proof", async () => {
    const record = bootstrap();
    expect(record.proof).toBeUndefined();
    expect(record.status).toBe("pending");
    const observed = await read([record]);
    expect(observed.purpose).toBe("auth-bootstrap");
  });
  it("denies missing Auth schema receipt, approval and a mismatched exact destination", async () => {
    const record = bootstrap();
    const missingAuth = structuredClone(record);
    delete requiredFixture(missingAuth.operator).authPreparation;
    await expect(read([missingAuth])).rejects.toThrow();
    const unapproved = structuredClone(record);
    delete requiredFixture(unapproved.operator).approvalId;
    await expect(read([unapproved])).rejects.toThrow();
    const foreign = structuredClone(record);
    foreign.request.projectId = "foreign-project";
    await expect(read([foreign])).rejects.toThrow();
  });
});
