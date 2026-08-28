import postgres from "postgres";

import { readPrivateDatabaseUrl } from "./private-database-url";
import { hostedTaskPostgresOptions } from "./postgres-connection-policy";
import { verifyHostedStorageReadBack } from "./hosted-storage-readiness";

if (
  process.argv.length !== 4 ||
  process.argv[2] !== "--database-url-fd" ||
  process.argv[3] !== "0"
) {
  throw new Error(
    "hosted:storage-verify requires its private database URL fd.",
  );
}

const databaseUrl = readPrivateDatabaseUrl(0);
const client = postgres(databaseUrl, hostedTaskPostgresOptions);
try {
  const readBack = await client.begin(async (transaction) => {
    await transaction`SET TRANSACTION READ ONLY`;
    const mode = await transaction<{ transactionReadOnly: string }[]>`
      SELECT current_setting('transaction_read_only') AS "transactionReadOnly"
    `;
    const migrations = await transaction<
      Array<{ hash: string; createdAt: string }>
    >`
      SELECT hash, created_at::text AS "createdAt"
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `;
    const columns = await transaction<
      Array<{
        table: string;
        column: string;
        type: string;
        notNull: boolean;
      }>
    >`
      SELECT
        relation.relname AS "table",
        attribute.attname AS "column",
        format_type(attribute.atttypid, attribute.atttypmod) AS "type",
        attribute.attnotnull AS "notNull"
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname IN (
          'account',
          'agent_operation',
          'agent_session',
          'github_installation_authorization_state',
          'github_publication_journal',
          'github_publication_proposal',
          'hosted_github_installation',
          'hosted_github_publication_journal',
          'hosted_github_publication_proposal',
          'hosted_workspace_membership',
          'jwks',
          'oauth_access_token',
          'oauth_client',
          'oauth_client_assertion',
          'oauth_client_resource',
          'oauth_consent',
          'oauth_refresh_token',
          'oauth_resource',
          'session',
          'user',
          'verification'
        )
        AND attribute.attnum > 0
        AND NOT attribute.attisdropped
      ORDER BY relation.relname, attribute.attname
    `;
    const indexes = await transaction<Array<{ table: string; name: string }>>`
      SELECT tablename AS "table", indexname AS "name"
      FROM pg_catalog.pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN (
          'account',
          'agent_operation',
          'agent_session',
          'github_installation_authorization_state',
          'github_publication_journal',
          'github_publication_proposal',
          'hosted_github_installation',
          'hosted_github_publication_journal',
          'hosted_github_publication_proposal',
          'hosted_workspace_membership',
          'jwks',
          'oauth_access_token',
          'oauth_client',
          'oauth_client_assertion',
          'oauth_client_resource',
          'oauth_consent',
          'oauth_refresh_token',
          'oauth_resource',
          'session',
          'user',
          'verification'
        )
      ORDER BY tablename, indexname
    `;
    const constraints = await transaction<
      Array<{ table: string; name: string }>
    >`
      SELECT relation.relname AS "table", constraint_record.conname AS "name"
      FROM pg_catalog.pg_constraint AS constraint_record
      JOIN pg_catalog.pg_class AS relation
        ON relation.oid = constraint_record.conrelid
      JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND constraint_record.contype <> 'n'
        AND relation.relname IN (
          'account',
          'agent_operation',
          'agent_session',
          'github_installation_authorization_state',
          'github_publication_journal',
          'github_publication_proposal',
          'hosted_github_installation',
          'hosted_github_publication_journal',
          'hosted_github_publication_proposal',
          'hosted_workspace_membership',
          'jwks',
          'oauth_access_token',
          'oauth_client',
          'oauth_client_assertion',
          'oauth_client_resource',
          'oauth_consent',
          'oauth_refresh_token',
          'oauth_resource',
          'session',
          'user',
          'verification'
        )
      ORDER BY relation.relname, constraint_record.conname
    `;
    return {
      transactionReadOnly: mode[0]?.transactionReadOnly === "on",
      migrations,
      columns,
      indexes,
      constraints,
    };
  });
  const receipt = await verifyHostedStorageReadBack({
    repositoryRoot: process.cwd(),
    readBack,
    observedAt: new Date(),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
} finally {
  await client.end({ timeout: 5 });
}
