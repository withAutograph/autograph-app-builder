import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  executeHostedAdminRequest,
  hostedAdminApplyRequestSchema,
  hostedAdminPlanRequestSchema,
  planHostedAdminRequest,
} from "./hosted-admin";
import { createPostgresHostedAdminStore } from "./postgres-hosted-admin";
import { readPrivateDatabaseUrl } from "./private-database-url";

const MAX_REQUEST_BYTES = 64 * 1024;
const actions = [
  "membership.seed",
  "membership.revoke",
  "retention.apply",
  "tenant.delete",
] as const;

async function readPrivateRequest(path: string): Promise<unknown> {
  if (!isAbsolute(path)) {
    throw new Error("Hosted admin request path must be absolute.");
  }
  const [link, canonicalPath] = await Promise.all([
    lstat(path),
    realpath(path),
  ]);
  if (link.isSymbolicLink() || canonicalPath !== path) {
    throw new Error(
      "Hosted admin request path must be canonical and unsymlinked.",
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
      "Hosted admin request must be an owner-only nonempty regular file.",
    );
  }
  return JSON.parse(await readFile(path, "utf8"));
}

const argv = process.argv.slice(2);
if (argv[0] === "plan") {
  if (argv.length !== 3 || argv[1] !== "--request-file") {
    throw new Error("hosted:admin-plan requires --request-file PATH.");
  }
  const request = hostedAdminPlanRequestSchema.parse(
    await readPrivateRequest(argv[2]),
  );
  process.stdout.write(`${JSON.stringify(planHostedAdminRequest(request))}\n`);
} else if (argv[0] === "apply") {
  if (
    argv.length !== 7 ||
    argv[1] !== "--expected-action" ||
    !actions.includes(argv[2] as (typeof actions)[number]) ||
    argv[3] !== "--database-url-fd" ||
    argv[4] !== "0" ||
    argv[5] !== "--request-file"
  ) {
    throw new Error("Hosted admin apply arguments were invalid.");
  }
  const request = hostedAdminApplyRequestSchema.parse(
    await readPrivateRequest(argv[6]),
  );
  if (request.action !== argv[2]) {
    throw new Error("Hosted admin request did not match the task action.");
  }
  const databaseUrl = readPrivateDatabaseUrl(0);
  const client = postgres(databaseUrl, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 5,
    prepare: false,
    onnotice: () => undefined,
  });
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
