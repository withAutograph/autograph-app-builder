import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("database migration secret boundary", () => {
  it("uses a task-scoped fd and never adds DATABASE_URL to the shared launcher", async () => {
    const [task, migration, launcher] = await Promise.all([
      readFile(".config/mise/tasks/database/migrate", "utf8"),
      readFile("lib/db/migrate.mts", "utf8"),
      readFile(".config/mise/scripts/trusted-node-launcher", "utf8"),
    ]);
    expect(task).toContain("unset DATABASE_URL");
    expect(task).toContain("printf '%s' \"$database_url\" | (");
    expect(task).not.toMatch(/\/(?:usr\/)?bin\/printf/u);
    expect(task).toContain("--database-url-fd 3 3<&0 </dev/null");
    expect(migration).toContain('process.argv[2] !== "--database-url-fd"');
    expect(migration).toContain("closeSync(3)");
    expect(migration).not.toContain("process.env.DATABASE_URL");
    expect(launcher).not.toMatch(/\bDATABASE_URL=/u);
  });
});
