import type { BuilderProvisionAuthority } from "../provisioning/journal";

export interface ProvisionRetryCursor extends BuilderProvisionAuthority {
  requestId: string;
}

export interface DueProvisioningOperation {
  authority: BuilderProvisionAuthority;
  requestId: string;
  operation: "github" | "vercel";
}

export interface ProvisionRetryPage {
  items: readonly DueProvisioningOperation[];
  nextCursor?: ProvisionRetryCursor;
}

export interface ProvisionRetryWorkerDependencies {
  listDue: (input: {
    now: Date;
    after?: ProvisionRetryCursor;
    limit: number;
  }) => Promise<ProvisionRetryPage>;
  isActiveMember: (authority: BuilderProvisionAuthority) => Promise<boolean>;
  pauseForRevokedAccess: (item: DueProvisioningOperation) => Promise<void>;
  execute: (item: DueProvisioningOperation) => Promise<void>;
}

const PAGE_SIZE = 100;
const cursorKey = (cursor: ProvisionRetryCursor) =>
  [cursor.issuer, cursor.audience, cursor.workspaceId, cursor.ownerUserId, cursor.requestId].join(
    "\0",
  );

// eslint-disable-next-line eslint/func-style -- Preserve named exported worker for diagnostics.
export async function retryDueProvisioning(
  dependencies: ProvisionRetryWorkerDependencies,
  now: Date = new Date(),
): Promise<{ resumed: number; paused: number }> {
  let after: ProvisionRetryCursor | undefined;
  let resumed = 0;
  let paused = 0;
  for (;;) {
    const query: Parameters<ProvisionRetryWorkerDependencies["listDue"]>[0] = {
      limit: PAGE_SIZE,
      now,
    };
    if (after) {
      query.after = after;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Page the durable queue in key order.
    const page = await dependencies.listDue(query);
    for (const item of page.items) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Recheck live membership before each outward operation.
      if (!(await dependencies.isActiveMember(item.authority))) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Persist an actionable pause for this operation.
        await dependencies.pauseForRevokedAccess(item);
        paused += 1;
        continue;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop -- The provider journal fences concurrent attempts.
      await dependencies.execute(item);
      resumed += 1;
    }
    if (!page.nextCursor) {
      return { paused, resumed };
    }
    if (after && cursorKey(page.nextCursor) <= cursorKey(after)) {
      throw new Error("Provisioning retry pagination did not advance.");
    }
    after = page.nextCursor;
  }
}
