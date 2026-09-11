import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  bindHostedGitHubInstallation,
  planHostedGitHubInstallation,
} from "./hosted-github-installation";

const request = {
  action: "github-installation.bind" as const,
  authority: {
    audience: "https://builder.example.test/mcp",
    issuer: "https://builder.example.test/api/auth",
    ownerUserId: "user_one",
    workspaceId: "workspace_one",
  },
  installation: {
    accountId: "456",
    accountLogin: "withAutograph",
    accountType: "Organization" as const,
    installationId: "123",
  },
  requestedAt: "2026-08-28T00:00:00.000Z",
  version: 1 as const,
};

describe("hosted GitHub installation binding", () => {
  it("plans and applies only the exactly confirmed tenant binding", async () => {
    const plan = planHostedGitHubInstallation(request);
    const bind = vi.fn(async ({ binding, now }) => ({
      ...binding,
      active: true,
      updatedAt: now,
    }));
    const receipt = await bindHostedGitHubInstallation({
      now: () => new Date("2026-08-28T00:01:00.000Z"),
      request: {
        ...request,
        confirmationDigest: plan.requiredConfirmationDigest,
      },
      store: { bind, read: vi.fn() },
    });
    expect(bind).toHaveBeenCalledWith({
      authority: request.authority,
      binding: request.installation,
      now: new Date("2026-08-28T00:01:00.000Z"),
    });
    expect(receipt).toMatchObject({
      authorityDigest: plan.authorityDigest,
      effects: { bindingActive: true, installationId: "123" },
      installationDigest: plan.installationDigest,
      status: "applied",
    });
    await expect(
      bindHostedGitHubInstallation({
        request: { ...request, confirmationDigest: `sha256:${"0".repeat(64)}` },
        store: { bind, read: vi.fn() },
      })
    ).rejects.toThrow(/confirmation/u);
  });

  it("keeps the mise apply path owner-only and task-scoped", async () => {
    const [task, cli] = await Promise.all([
      readFile(".config/mise/tasks/hosted/github-installation-bind", "utf-8"),
      readFile("lib/db/hosted-github-installation-cli.mts", "utf-8"),
    ]);
    expect(task).toContain("unset DATABASE_URL");
    expect(task).toContain("--database-url-fd 0");
    expect(cli).toContain("metadata.uid !== process.getuid?.()");
    expect(cli).toContain("(metadata.mode & 0o077) !== 0");
    expect(cli).not.toContain("process.env.DATABASE_URL");
  });
});
