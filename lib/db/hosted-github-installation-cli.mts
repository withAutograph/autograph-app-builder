import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  bindHostedGitHubInstallation,
  hostedGitHubInstallationApplyRequestSchema,
  hostedGitHubInstallationPlanRequestSchema,
  planHostedGitHubInstallation,
} from "./hosted-github-installation";
import { readPrivateDatabaseUrl } from "./private-database-url";
import { hostedTaskPostgresOptions } from "./postgres-connection-policy";
import { createPostgresHostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";

const MAX_REQUEST_BYTES = 16 * 1024;

async function readOwnerOnlyRequest(path: string): Promise<unknown> {
  if (!isAbsolute(path)) throw new Error("Request path must be absolute.");
  const [link, canonicalPath] = await Promise.all([
    lstat(path),
    realpath(path),
  ]);
  if (link.isSymbolicLink() || canonicalPath !== path)
    throw new Error("Request path must be canonical and unsymlinked.");
  const metadata = await stat(path);
  if (
    !metadata.isFile() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size === 0 ||
    metadata.size > MAX_REQUEST_BYTES
  )
    throw new Error("Request must be an owner-only nonempty regular file.");
  return JSON.parse(await readFile(path, "utf8"));
}

const argv = process.argv.slice(2);
if (argv[0] === "plan") {
  if (argv.length !== 3 || argv[1] !== "--request-file")
    throw new Error("Plan requires --request-file PATH.");
  const request = hostedGitHubInstallationPlanRequestSchema.parse(
    await readOwnerOnlyRequest(argv[2]),
  );
  process.stdout.write(
    `${JSON.stringify(planHostedGitHubInstallation(request))}\n`,
  );
} else if (argv[0] === "apply") {
  if (
    argv.length !== 5 ||
    argv[1] !== "--database-url-fd" ||
    argv[2] !== "0" ||
    argv[3] !== "--request-file"
  )
    throw new Error("Apply arguments were invalid.");
  const request = hostedGitHubInstallationApplyRequestSchema.parse(
    await readOwnerOnlyRequest(argv[4]),
  );
  const client = postgres(readPrivateDatabaseUrl(0), hostedTaskPostgresOptions);
  try {
    const receipt = await bindHostedGitHubInstallation({
      request,
      store: createPostgresHostedGitHubInstallationStore(drizzle(client)),
    });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } finally {
    await client.end({ timeout: 5 });
  }
} else {
  throw new Error("Expected plan or apply mode.");
}
