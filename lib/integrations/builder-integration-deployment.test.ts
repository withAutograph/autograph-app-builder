import { describe, expect, it, vi } from "vitest";

import { resolveBuilderWorkspaceId } from "./builder-integration-deployment";

describe("builder integration deployment", () => {
  it("reuses the workspace resolved by signed-in session reconciliation", async () => {
    const activeWorkspaceForUser = vi.fn();

    await expect(
      resolveBuilderWorkspaceId({
        workspaceId: "workspace_one",
        membership: { activeWorkspaceForUser } as never,
        issuer: "https://builder.example/api/auth",
        audience: "https://builder.example/mcp",
        ownerUserId: "user_one",
      }),
    ).resolves.toBe("workspace_one");
    expect(activeWorkspaceForUser).not.toHaveBeenCalled();
  });

  it("falls back to a fresh membership read outside the page reconciliation path", async () => {
    const activeWorkspaceForUser = vi.fn(async () => "workspace_one");

    await expect(
      resolveBuilderWorkspaceId({
        membership: { activeWorkspaceForUser } as never,
        issuer: "https://builder.example/api/auth",
        audience: "https://builder.example/mcp",
        ownerUserId: "user_one",
      }),
    ).resolves.toBe("workspace_one");
    expect(activeWorkspaceForUser).toHaveBeenCalledWith({
      issuer: "https://builder.example/api/auth",
      audience: "https://builder.example/mcp",
      ownerUserId: "user_one",
    });
  });
});
