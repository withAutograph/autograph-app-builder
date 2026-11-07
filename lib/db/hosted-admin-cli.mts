import { lstat, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type { ZodType } from "zod";

import {
  executeHostedAdminRequest,
  hostedAdminApplyRequestSchema,
  hostedAdminPlanRequestSchema,
  planHostedAdminRequest,
} from "./hosted-admin";
import { createPostgresHostedAdminStore } from "./postgres-hosted-admin";
import { readPrivateDatabaseUrl } from "./private-database-url";
import { hostedTaskPostgresOptions } from "./postgres-connection-policy";

const MAX_REQUEST_BYTES = 64 * 1024;
const actions = [
  "membership.seed",
  "membership.revoke",
  "retention.apply",
  "tenant.delete",
] as const;

const hasValidApplyArguments = (argv: string[]) => {
  const hasExpectedLength = argv.length === 7;
  const hasExpectedActionFlag = argv[1] === "--expected-action";
  if (!hasExpectedLength || !hasExpectedActionFlag) {
    return false;
  }
  return (
    actions.some((action) => action === argv[2]) &&
    argv[3] === "--database-url-fd" &&
    argv[4] === "0" &&
    argv[5] === "--request-file"
  );
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readPrivateRequest<T>(requestPath: string, schema: ZodType<T>): Promise<T> {
  if (!path.isAbsolute(requestPath)) {
    throw new Error("Hosted admin request path must be absolute.");
  }
  const [link, canonicalPath] = await Promise.all([lstat(requestPath), realpath(requestPath)]);
  if (link.isSymbolicLink() || canonicalPath !== requestPath) {
    throw new Error("Hosted admin request path must be canonical and unsymlinked.");
  }
  const metadata = await stat(requestPath);
  if (
    !metadata.isFile() ||
    metadata.uid !== process.getuid?.() ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (metadata.mode & 0o077) !== 0 ||
    metadata.size === 0
  ) {
    throw new Error("Hosted admin request must be an owner-only nonempty regular file.");
  }
  if (metadata.size > MAX_REQUEST_BYTES) {
    throw new Error("Hosted admin request must be an owner-only nonempty regular file.");
  }
  return schema.parse(JSON.parse(await readFile(requestPath, "utf-8")));
}

const argv = process.argv.slice(2);
if (argv[0] === "plan") {
  if (argv.length !== 3 || argv[1] !== "--request-file") {
    throw new Error("hosted:admin-plan requires --request-file PATH.");
  }
  const request = await readPrivateRequest(argv[2], hostedAdminPlanRequestSchema);
  process.stdout.write(`${JSON.stringify(planHostedAdminRequest(request))}\n`);
} else if (argv[0] === "apply") {
  if (!hasValidApplyArguments(argv)) {
    throw new Error("Hosted admin apply arguments were invalid.");
  }
  const request = await readPrivateRequest(argv[6], hostedAdminApplyRequestSchema);
  if (request.action !== argv[2]) {
    throw new Error("Hosted admin request did not match the task action.");
  }
  const databaseUrl = readPrivateDatabaseUrl(0);
  const client = postgres(databaseUrl, hostedTaskPostgresOptions);
  try {
    const receipt = await executeHostedAdminRequest({
      request,
      store: createPostgresHostedAdminStore(drizzle(client)),
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await client.end({ timeout: 5 });
  }
} else {
  throw new Error("Expected hosted admin plan or apply mode.");
}
