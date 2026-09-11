import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { hostedTaskPostgresOptions } from "../db/postgres-connection-policy";
import { readPrivateDatabaseUrl } from "../db/private-database-url";
import * as schema from "../db/schema";
import { setupCursorClient } from "./cursor-client";
import { readPreviewOAuthContractConfig } from "./preview-oauth-contract";

const [flag, fd, resourceFlag, resource] = process.argv.slice(2);
if (
  process.argv.length !== 6 ||
  flag !== "--database-url-fd" ||
  fd !== "0" ||
  resourceFlag !== "--resource" ||
  !resource
) {
  throw new Error(
    "Use hosted:cursor-client-setup with --resource and its private database URL fd."
  );
}
readPreviewOAuthContractConfig({
  BETTER_AUTH_URL: `${new URL(resource).origin}/api/auth`,
  MCP_RESOURCE_URL: resource,
});
const client = postgres(readPrivateDatabaseUrl(0), hostedTaskPostgresOptions);
try {
  console.log(
    JSON.stringify(
      await setupCursorClient(drizzle(client, { schema }), resource)
    )
  );
} catch {
  console.error(
    "Cursor client setup failed. Check OAuth resource initialization and dedicated client configuration."
  );
  process.exitCode = 1;
} finally {
  await client.end({ timeout: 5 });
}
