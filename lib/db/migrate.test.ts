import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("database migration secret boundary", () => {
  it("uses a task-scoped fd and never adds DATABASE_URL to the shared launcher", async () => {
    const [task, migration, launcher] = await Promise.all([
      readFile(".config/mise/tasks/database/migrate", "utf8"),
      readFile("lib/db/private-database-url.ts", "utf8"),
      readFile(".config/mise/scripts/trusted-node-launcher", "utf8"),
    ]);
    expect(task).toContain("unset DATABASE_URL");
    expect(task).toContain("printf '%s' \"$database_url\" | (");
    expect(task).not.toMatch(/\/(?:usr\/)?bin\/printf/u);
    expect(task).toContain("--database-url-fd 0");
    expect(migration).toContain("closeSync(fd)");
    expect(migration).not.toContain("process.env.DATABASE_URL");
    expect(launcher).not.toMatch(/\bDATABASE_URL=/u);
  });

  it("keeps all hosted mutations confirmation-bound and secret-blind", async () => {
    const paths = [
      ".config/mise/tasks/hosted/membership-seed",
      ".config/mise/tasks/hosted/membership-revoke",
      ".config/mise/tasks/hosted/retention-apply",
      ".config/mise/tasks/hosted/tenant-delete",
    ];
    for (const path of paths) {
      const task = await readFile(path, "utf8");
      expect(task).toContain("unset DATABASE_URL");
      expect(task).toContain("--database-url-fd 0");
      expect(task).toContain("--request-file");
      expect(task).not.toContain("echo $DATABASE_URL");
    }
    const cli = await readFile("lib/db/hosted-admin-cli.mts", "utf8");
    expect(cli).toContain("owner-only nonempty regular file");
    expect(cli).not.toContain("process.env.DATABASE_URL");
  });

  it("adds exact tenant retention indexes without weakening durable keys", async () => {
    const migration = await readFile(
      "drizzle/0003_hosted_retention_indexes.sql",
      "utf8",
    );
    expect(migration).toContain('"agent_session_retention_idx"');
    expect(migration).toContain('"agent_operation_retention_idx"');
    expect(migration).toContain(
      '"issuer", "audience", "workspace_id", "owner_user_id", "updated_at"',
    );
    const adapter = await readFile("lib/db/postgres-hosted-admin.ts", "utf8");
    expect(adapter).toContain('ne(agentOperations.state, "reserved")');
    expect(adapter).toContain("notExists(");
    expect(adapter).toContain("drained inactive membership");
  });

  it("migrates an exact fail-closed hosted workspace membership authority", async () => {
    const migration = await readFile(
      "drizzle/0002_hosted_workspace_membership.sql",
      "utf8",
    );
    expect(migration).toContain('CREATE TABLE "hosted_workspace_membership"');
    expect(migration).toContain('"active" boolean DEFAULT false NOT NULL');
    expect(migration).toContain(
      '"issuer", "audience", "workspace_id", "owner_user_id"',
    );
  });
});
