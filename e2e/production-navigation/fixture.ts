import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { makeSignature } from "better-auth/crypto";
import postgres from "postgres";
import { z } from "zod";
import type { BrowserContext } from "playwright/test";

const fixtureSchema = z.object({
  origin: z.string().url(),
  databaseUrl: z.string().url(),
  secret: z.string().min(32),
  flagsSecret: z.string().min(32),
});

export function readNavigationFixture() {
  const fixture = fixtureSchema.parse(
    JSON.parse(readFileSync(".navigation-fixture.json", "utf-8")),
  );
  const origin = new URL(fixture.origin);
  const database = new URL(fixture.databaseUrl);
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== "localhost" ||
    !origin.port ||
    database.protocol !== "postgresql:" ||
    database.hostname !== "127.0.0.1" ||
    !database.port ||
    !/^\/autograph_navigation_[a-z0-9_]+$/u.test(database.pathname)
  ) {
    throw new Error("Production navigation requires its isolated loopback fixture.");
  }
  return fixture;
}

export async function blockExternalRequests(context: BrowserContext) {
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    await (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ? route.continue()
      : route.abort("blockedbyclient"));
  });
}

/** Seed real Better Auth rows in the runner-owned disposable database only. */
export async function seedIdentity(context: BrowserContext, appName: string) {
  const fixture = readNavigationFixture();
  const id = randomUUID();
  const organization = randomUUID();
  const workspace = randomUUID();
  const token = randomUUID();
  const email = `${id}@navigation.example.test`;
  const sql = postgres(fixture.databaseUrl, { max: 1 });
  try {
    await sql.begin(async (transaction) => {
      await transaction`insert into "user" (id, name, email, email_verified, created_at, updated_at)
        values (${id}, ${appName}, ${email}, true, now(), now())`;
      await transaction`insert into organization (id, name, slug, created_at, issuer, audience, workspace_id)
        values (${organization}, ${appName}, ${organization}, now(), ${`${fixture.origin}/api/auth`}, ${`${fixture.origin}/mcp`}, ${workspace})`;
      await transaction`insert into member (id, organization_id, user_id, role, created_at)
        values (${randomUUID()}, ${organization}, ${id}, 'owner', now())`;
      await transaction`insert into personal_workspace (user_id, organization_id, created_at)
        values (${id}, ${organization}, now())`;
      await transaction`insert into session (id, token, user_id, active_organization_id, expires_at, created_at, updated_at)
        values (${randomUUID()}, ${token}, ${id}, ${organization}, now() + interval '1 hour', now(), now())`;
      const record = {
        version: 1,
        draft: {
          version: 1,
          form: {
            appName,
            repository: "navigation-proof",
            brief: `Saved brief for ${appName}`,
            privateRepository: true,
            buildDestination: "codex",
            connections: [],
            modelId: "",
          },
          team: "",
          gitScope: "",
          model: "",
          zdrOnly: false,
          showMoreConnections: false,
          search: "",
          connectedConnections: [],
          storageProvider: null,
          deploymentProvider: null,
          focusOrigin: "github",
          appNameEditedByUser: true,
          repositoryEditedByUser: true,
        },
      };
      await transaction`insert into builder_draft (issuer, audience, workspace_id, owner_user_id, draft_id, revision, record, created_at, updated_at)
        values (${`${fixture.origin}/api/auth`}, ${`${fixture.origin}/mcp`}, ${workspace}, ${id}, ${randomUUID()}, 1, ${transaction.json(record)}, now(), now())`;
    });
  } finally {
    await sql.end();
  }
  const signature = await makeSignature(token, fixture.secret);
  await context.addCookies([
    {
      name: "__Secure-autograph_app_builder.session_token",
      value: encodeURIComponent(`${token}.${signature}`),
      url: fixture.origin,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const response = await context.request.get(`${fixture.origin}/api/auth/get-session`);
  if (!response.ok()) throw new Error("Seeded Better Auth session was rejected.");
  const session: unknown = await response.json();
  if (z.object({ user: z.object({ id: z.literal(id) }) }).safeParse(session).success !== true) {
    throw new Error("Seeded Better Auth session did not resolve the expected identity.");
  }
  return { id, email, appName };
}
