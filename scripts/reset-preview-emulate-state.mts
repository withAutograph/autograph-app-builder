import { z } from "zod";

import { previewEmulationNamespace } from "../lib/integrations/local-provider-emulation";
import { resetPostgresPreviewEmulateState } from "../lib/integrations/preview-emulate-persistence";
import { readPrivateDatabaseUrl } from "../lib/db/private-database-url";

const args = z
  .tuple([
    z.literal("--database-url-fd"),
    z.literal("0"),
    z.literal("--repository"),
    z.string().min(1).max(255),
    z.literal("--project"),
    z.string().min(1).max(255),
    z.literal("--branch"),
    z.string().min(1).max(255),
  ])
  .parse(process.argv.slice(2));

const namespace = previewEmulationNamespace({
  repository: args[3],
  project: args[5],
  branch: args[7],
});
const deleted = await resetPostgresPreviewEmulateState(
  readPrivateDatabaseUrl(0),
  namespace,
);

process.stdout.write(
  `${JSON.stringify({ namespace, deleted, reseedOnNextRequest: true })}\n`,
);
