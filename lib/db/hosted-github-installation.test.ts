import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  bindHostedGitHubInstallation,
  planHostedGitHubInstallation,
} from "./hosted-github-installation";

const request = {
  version: 1 as const,
  action: "github-installation.bind" as const,
  authority: {
    issuer: "https://builder.example.test/api/auth",
    audience: "https://builder.example.test/mcp",
    workspaceId: "workspace_one",
    ownerUserId: "user_one",
  },
  installation: {
    installationId: "123",
    accountId: "456",
    accountLogin: "withAutograph",
    accountType: "Organization" as const,
  },
  requestedAt: "2026-08-28T00:00:00.000Z",
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
      request: {
        ...request,
        confirmationDigest: plan.requiredConfirmationDigest,
      },
      store: { read: vi.fn(), bind },
      now: () => new Date("2026-08-28T00:01:00.000Z"),
    });
    expect(bind).toHaveBeenCalledWith({
      authority: request.authority,
      binding: request.installation,
      now: new Date("2026-08-28T00:01:00.000Z"),
    });
    expect(receipt).toMatchObject({
      status: "applied",
      authorityDigest: plan.authorityDigest,
      installationDigest: plan.installationDigest,
      effects: { bindingActive: true, installationId: "123" },
    });
    await expect(
      bindHostedGitHubInstallation({
        request: { ...request, confirmationDigest: `sha256:${"0".repeat(64)}` },
        store: { read: vi.fn(), bind },
      }),
    ).rejects.toThrow(/confirmation/u);
  });

  it("keeps the mise apply path owner-only and task-scoped", async () => {
    const [task, cli] = await Promise.all([
      readFile(".config/mise/tasks/hosted/github-installation-bind", "utf8"),
      readFile("lib/db/hosted-github-installation-cli.mts", "utf8"),
    ]);
    expect(task).toContain("unset DATABASE_URL");
    expect(task).toContain("--database-url-fd 0");
    expect(cli).toContain("metadata.uid !== process.getuid?.()");
    expect(cli).toContain("(metadata.mode & 0o077) !== 0");
    expect(cli).not.toContain("process.env.DATABASE_URL");
  });
});
