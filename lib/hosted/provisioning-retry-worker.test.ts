import { describe, expect, it, vi } from "vitest";

import { retryDueProvisioning } from "./provisioning-retry-worker";
import type {
  DueProvisioningOperation,
  ProvisionRetryCursor,
  ProvisionRetryPage,
} from "./provisioning-retry-worker";

const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
};

const work = (index: number): DueProvisioningOperation => ({
  authority,
  operation: "github",
  requestId: index.toString().padStart(4, "0"),
});

describe("durable provisioning retry worker", () => {
  it("continues beyond one page while pausing revoked members before any provider call", async () => {
    const due = Array.from({ length: 205 }, (_, index) => work(index));
    const execute = vi.fn(async (_item: DueProvisioningOperation) => {
      await Promise.resolve();
    });
    const pauseForRevokedAccess = vi.fn(async (_item: DueProvisioningOperation) => {
      await Promise.resolve();
    });
    const listDue = vi.fn(async (input: { after?: ProvisionRetryCursor; limit: number }) => {
      const start = input.after ? Number(input.after.requestId) + 1 : 0;
      const items = due.slice(start, start + input.limit);
      const last = items.at(-1);
      const page: ProvisionRetryPage = { items };
      if (start + items.length < due.length && last) {
        page.nextCursor = { ...authority, requestId: last.requestId };
      }
      return await Promise.resolve(page);
    });
    const result = await retryDueProvisioning({
      execute,
      // oxlint-disable-next-line eslint/require-await -- test double.
      isActiveMember: async ({ ownerUserId }) => ownerUserId === authority.ownerUserId,
      listDue,
      pauseForRevokedAccess,
    });
    expect(result).toEqual({ paused: 0, resumed: 205 });
    expect(listDue).toHaveBeenCalledTimes(3);
    expect(execute).toHaveBeenCalledTimes(205);

    due[204] = { ...due[204], authority: { ...authority, ownerUserId: "revoked" } };
    execute.mockClear();
    const second = await retryDueProvisioning({
      execute,
      // oxlint-disable-next-line eslint/require-await -- test double.
      isActiveMember: async ({ ownerUserId }) => ownerUserId === authority.ownerUserId,
      listDue,
      pauseForRevokedAccess,
    });
    expect(second).toEqual({ paused: 1, resumed: 204 });
    expect(execute).not.toHaveBeenCalledWith(due[204]);
    expect(pauseForRevokedAccess).toHaveBeenCalledWith(due[204]);
  });

  it("rejects a non-advancing page cursor before looping indefinitely", async () => {
    await expect(
      retryDueProvisioning({
        execute: vi.fn(),
        isActiveMember: vi.fn(),
        listDue: vi.fn(
          async () =>
            await Promise.resolve({
              items: [],
              nextCursor: { ...authority, requestId: "0001" },
            }),
        ),
        pauseForRevokedAccess: vi.fn(),
      }),
    ).rejects.toThrow("did not advance");
  });
});
