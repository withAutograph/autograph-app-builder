import { createHash } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as databaseSchema from "./schema";
import {
  assertRuntimeRoleReadback,
  executePreviewActivation,
  planPreviewActivation,
  previewActivationApplyRequestSchema,
  previewActivationPlanRequestSchema,
  type PreviewActivationStore,
} from "./preview-activation";
import { readPrivateDatabaseUrl } from "./private-database-url";
import { hostedTaskPostgresOptions } from "./postgres-connection-policy";
import { createPreviewOAuthServer } from "../auth/preview-oauth-runtime";

const MAX_REQUEST_BYTES = 64 * 1024;

async function readPrivateRequest(path: string): Promise<unknown> {
  if (!isAbsolute(path))
    throw new Error("Activation request path must be absolute.");
  const [link, canonicalPath] = await Promise.all([
    lstat(path),
    realpath(path),
  ]);
  if (link.isSymbolicLink() || canonicalPath !== path) {
    throw new Error(
      "Activation request path must be canonical and unsymlinked.",
    );
  }
  const metadata = await stat(path);
  if (
    !metadata.isFile() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size === 0 ||
    metadata.size > MAX_REQUEST_BYTES
  ) {
    throw new Error(
      "Activation request must be an owner-only nonempty regular file.",
    );
  }
  return JSON.parse(await readFile(path, "utf8"));
}

function stableId(prefix: string, value: string) {
  return `${prefix}_${createHash("sha256").update(value).digest("hex")}`;
}

async function configureLoginRole(
  sql: Sql,
  action: "create" | "alter",
  roleName: string,
  password: string,
) {
  const template = `${action} role %I login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password %L`;
  const rows = await sql<{ statement: string }[]>`
    select format(${template}::text, ${roleName}::text, ${password}::text) as statement
  `;
  const statement = rows[0]?.statement;
  if (
    statement === undefined ||
    statement.length > 2_048 ||
    /[\0\r\n]/u.test(statement)
  ) {
    throw new Error("Runtime database role statement was invalid.");
  }
  try {
    await sql.unsafe(statement);
  } catch {
    throw new Error("Runtime database role configuration failed.");
  }
}

function createStore(sql: Sql): PreviewActivationStore {
  return {
    async provisionInvitedUser(input) {
      return sql.begin(async (transaction) => {
        const users = await transaction<
          {
            id: string;
            name: string;
            email: string;
            email_verified: boolean;
          }[]
        >`select id, name, email, email_verified from "user" where id = ${input.userId} or email = ${input.email} for update`;
        const accountId = stableId(
          "account",
          `github:${input.githubAccountId}`,
        );
        const accounts = await transaction<
          {
            id: string;
            issuer: string;
            account_id: string;
            provider_id: string;
            user_id: string;
            password: string | null;
          }[]
        >`select id, issuer, account_id, provider_id, user_id, password from account where id = ${accountId} or (issuer = 'local:oauth:github' and account_id = ${input.githubAccountId}) for update`;
        const memberships = await transaction<
          {
            active: boolean;
          }[]
        >`select active from hosted_workspace_membership where issuer = ${input.issuer} and audience = ${input.resource} and workspace_id = ${input.workspaceId} and owner_user_id = ${input.userId} for update`;
        let userRowsAffected = 0;
        let accountRowsAffected = 0;
        let membershipRowsAffected = 0;
        if (users.length === 0) {
          const now = new Date(input.requestedAt);
          await transaction`insert into "user" (id, name, email, email_verified, created_at, updated_at) values (${input.userId}, ${input.githubLogin}, ${input.email}, true, ${now}, ${now})`;
          userRowsAffected = 1;
        } else if (
          users.length !== 1 ||
          users[0]?.id !== input.userId ||
          users[0]?.email !== input.email ||
          users[0]?.name !== input.githubLogin ||
          users[0]?.email_verified !== true
        ) {
          throw new Error(
            "Invited user identity conflicts with an existing row.",
          );
        }
        if (accounts.length === 0) {
          const now = new Date(input.requestedAt);
          await transaction`insert into account (id, issuer, account_id, provider_id, user_id, password, created_at, updated_at) values (${accountId}, 'local:oauth:github', ${input.githubAccountId}, 'github', ${input.userId}, null, ${now}, ${now})`;
          accountRowsAffected = 1;
        } else {
          const account = accounts[0];
          if (
            accounts.length !== 1 ||
            account?.id !== accountId ||
            account.issuer !== "local:oauth:github" ||
            account.account_id !== input.githubAccountId ||
            account.provider_id !== "github" ||
            account.user_id !== input.userId ||
            account.password !== null
          ) {
            throw new Error(
              "Invited GitHub identity conflicts with an existing row.",
            );
          }
        }
        if (memberships.length === 0) {
          const now = new Date(input.requestedAt);
          await transaction`insert into hosted_workspace_membership (issuer, audience, workspace_id, owner_user_id, active, updated_at) values (${input.issuer}, ${input.resource}, ${input.workspaceId}, ${input.userId}, true, ${now})`;
          membershipRowsAffected = 1;
        } else if (
          memberships.length !== 1 ||
          memberships[0]?.active !== true
        ) {
          throw new Error(
            "Invited user membership conflicts with an existing row.",
          );
        }
        return {
          userRowsAffected,
          accountRowsAffected,
          membershipRowsAffected,
        };
      });
    },

    async configureRuntimeRole(input) {
      const existing = await sql<
        { rolcanlogin: boolean; membership_count: number }[]
      >`select r.rolcanlogin,
          (select count(*)::integer from pg_auth_members m where m.member = r.oid) as membership_count
        from pg_roles r where r.rolname = ${input.roleName}`;
      const runtimeRoleCreated = existing.length === 0;
      if (runtimeRoleCreated) {
        await configureLoginRole(sql, "create", input.roleName, input.password);
      } else if (
        existing.length !== 1 ||
        existing[0]?.rolcanlogin !== true ||
        existing[0]?.membership_count !== 0
      ) {
        throw new Error(
          "Runtime database role exists with incompatible authority or membership.",
        );
      } else {
        await configureLoginRole(sql, "alter", input.roleName, input.password);
      }
      const database = await sql<
        { name: string }[]
      >`select current_database() as name`;
      const databaseName = database[0]?.name;
      if (databaseName === undefined)
        throw new Error("Database identity was unavailable.");
      await sql`revoke all privileges on database ${sql(databaseName)} from ${sql(input.roleName)}`;
      await sql`revoke all privileges on schema public from ${sql(input.roleName)}`;
      await sql`revoke all privileges on all tables in schema public from ${sql(input.roleName)}`;
      await sql`revoke all privileges on all sequences in schema public from ${sql(input.roleName)}`;
      await sql`grant connect on database ${sql(databaseName)} to ${sql(input.roleName)}`;
      await sql`grant usage on schema public to ${sql(input.roleName)}`;
      await sql`grant select, insert, update, delete on all tables in schema public to ${sql(input.roleName)}`;
      await sql`grant usage, select on all sequences in schema public to ${sql(input.roleName)}`;
      const owner = await sql<
        { owner: string }[]
      >`select current_user as owner`;
      const ownerName = owner[0]?.owner;
      if (ownerName === undefined)
        throw new Error("Migration owner was unavailable.");
      await sql`alter default privileges for role ${sql(ownerName)} in schema public revoke all privileges on tables from ${sql(input.roleName)}`;
      await sql`alter default privileges for role ${sql(ownerName)} in schema public revoke all privileges on sequences from ${sql(input.roleName)}`;
      await sql`alter default privileges for role ${sql(ownerName)} in schema public grant select, insert, update, delete on tables to ${sql(input.roleName)}`;
      await sql`alter default privileges for role ${sql(ownerName)} in schema public grant usage, select on sequences to ${sql(input.roleName)}`;
      const verification = await sql<
        {
          can_connect: boolean;
          can_use_schema: boolean;
          can_create_schema_objects: boolean;
          table_privileges_exact: boolean;
          sequence_privileges_exact: boolean;
          rolcanlogin: boolean;
          rolinherit: boolean;
          rolsuper: boolean;
          rolcreatedb: boolean;
          rolcreaterole: boolean;
          rolreplication: boolean;
          rolbypassrls: boolean;
          membership_count: number;
        }[]
      >`
        select
          has_database_privilege(${input.roleName}, current_database(), 'CONNECT') as can_connect,
          has_schema_privilege(${input.roleName}, 'public', 'USAGE') as can_use_schema,
          has_schema_privilege(${input.roleName}, 'public', 'CREATE') as can_create_schema_objects,
          not exists (
            select 1 from information_schema.tables t
            where t.table_schema = 'public' and t.table_type = 'BASE TABLE'
              and not (
                has_table_privilege(${input.roleName}, quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'SELECT') and
                has_table_privilege(${input.roleName}, quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'INSERT') and
                has_table_privilege(${input.roleName}, quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'UPDATE') and
                has_table_privilege(${input.roleName}, quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'DELETE') and
                not has_table_privilege(${input.roleName}, quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'TRUNCATE') and
                not has_table_privilege(${input.roleName}, quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'REFERENCES') and
                not has_table_privilege(${input.roleName}, quote_ident(t.table_schema) || '.' || quote_ident(t.table_name), 'TRIGGER')
              )
          ) as table_privileges_exact,
          not exists (
            select 1 from information_schema.sequences s
            where s.sequence_schema = 'public'
              and not (
                has_sequence_privilege(${input.roleName}, quote_ident(s.sequence_schema) || '.' || quote_ident(s.sequence_name), 'USAGE') and
                has_sequence_privilege(${input.roleName}, quote_ident(s.sequence_schema) || '.' || quote_ident(s.sequence_name), 'SELECT') and
                not has_sequence_privilege(${input.roleName}, quote_ident(s.sequence_schema) || '.' || quote_ident(s.sequence_name), 'UPDATE')
              )
          ) as sequence_privileges_exact,
          r.rolcanlogin, r.rolinherit, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
          r.rolreplication, r.rolbypassrls,
          (select count(*)::integer from pg_auth_members m where m.member = r.oid) as membership_count
        from pg_roles r where r.rolname = ${input.roleName}`;
      const readback = verification[0];
      if (readback === undefined) {
        throw new Error("Runtime database role readback was unavailable.");
      }
      try {
        assertRuntimeRoleReadback({
          canConnect: readback.can_connect,
          canUseSchema: readback.can_use_schema,
          canCreateSchemaObjects: readback.can_create_schema_objects,
          tablePrivilegesExact: readback.table_privileges_exact,
          sequencePrivilegesExact: readback.sequence_privileges_exact,
          canLogin: readback.rolcanlogin,
          inherits: readback.rolinherit,
          superuser: readback.rolsuper,
          createDatabase: readback.rolcreatedb,
          createRole: readback.rolcreaterole,
          replication: readback.rolreplication,
          bypassRls: readback.rolbypassrls,
          membershipCount: readback.membership_count,
        });
      } catch {
        throw new Error(
          "Runtime database role readback was not least privilege.",
        );
      }
      return {
        runtimeRoleCreated,
        runtimeRoleLogin: true,
        runtimeRoleCanConnect: true,
        runtimeRoleCanUseSchema: true,
        runtimeRoleCanCreateSchemaObjects: false as const,
        runtimeRoleTablePrivilegesExact: true,
        runtimeRoleSequencePrivilegesExact: true,
        runtimeRoleAttributesExact: true,
        runtimeRoleMembershipCount: 0 as const,
      };
    },

    async initializeOAuth(input) {
      const beforeResource = await sql<
        { count: number }[]
      >`select count(*)::integer as count from oauth_resource where identifier = ${input.resource}`;
      const beforeJwks = await sql<
        { count: number }[]
      >`select count(*)::integer as count from jwks`;
      const database = drizzle(sql, { schema: databaseSchema });
      const auth = createPreviewOAuthServer({
        config: {
          hostedAdapter: "1",
          environment: "preview",
          issuer: input.issuer,
          resource: input.resource,
          secret: input.authSecret,
          databaseUrl: "postgresql://task-scoped.invalid/database",
          githubClientId: "task-scoped-oauth-initialization",
          githubClientSecret: "task-scoped-oauth-initialization",
          vercelClientId: "task-scoped-oauth-initialization",
          vercelClientSecret: "task-scoped-oauth-initialization",
        },
        database: drizzleAdapter(database, {
          provider: "pg",
          schema: databaseSchema,
          transaction: true,
        }),
        membership: {
          async activeWorkspaceForUser() {
            return undefined;
          },
          async isActiveMember() {
            return false;
          },
        },
      });
      const metadata = await auth.handler(
        new Request(`${input.issuer}/.well-known/oauth-authorization-server`),
      );
      const keys = await auth.handler(new Request(`${input.issuer}/jwks`));
      if (metadata.status !== 200 || keys.status !== 200) {
        throw new Error("OAuth resource or JWKS initialization failed closed.");
      }
      const afterResource = await sql<
        { count: number }[]
      >`select count(*)::integer as count from oauth_resource where identifier = ${input.resource}`;
      const afterJwks = await sql<
        { count: number }[]
      >`select count(*)::integer as count from jwks`;
      if (afterResource[0]?.count !== 1 || (afterJwks[0]?.count ?? 0) < 1) {
        throw new Error(
          "OAuth resource or JWKS initialization readback failed.",
        );
      }
      return {
        resourceRowsBefore: beforeResource[0]?.count ?? 0,
        resourceRowsAfter: afterResource[0].count,
        jwksRowsBefore: beforeJwks[0]?.count ?? 0,
        jwksRowsAfter: afterJwks[0].count,
      };
    },
  };
}

const argv = process.argv.slice(2);
if (argv[0] === "plan") {
  if (argv.length !== 3 || argv[1] !== "--request-file") {
    throw new Error("hosted:activation-plan requires --request-file PATH.");
  }
  const request = previewActivationPlanRequestSchema.parse(
    await readPrivateRequest(argv[2]),
  );
  process.stdout.write(`${JSON.stringify(planPreviewActivation(request))}\n`);
} else if (argv[0] === "apply") {
  if (
    argv.length !== 7 ||
    argv[1] !== "--expected-action" ||
    argv[3] !== "--database-url-fd" ||
    argv[4] !== "0" ||
    argv[5] !== "--request-file"
  ) {
    throw new Error("Preview activation apply arguments were invalid.");
  }
  const request = previewActivationApplyRequestSchema.parse(
    await readPrivateRequest(argv[6]),
  );
  if (request.action !== argv[2]) {
    throw new Error(
      "Preview activation request did not match the task action.",
    );
  }
  const databaseUrl = readPrivateDatabaseUrl(0);
  const client = postgres(databaseUrl, hostedTaskPostgresOptions);
  try {
    const receipt = await executePreviewActivation({
      request,
      store: createStore(client),
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await client.end({ timeout: 5 });
  }
} else {
  throw new Error("Expected Preview activation plan or apply mode.");
}
