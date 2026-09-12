import { deleteInactiveBuilderDraftsForMaintenance } from "../lib/builder-drafts/deployment";

try {
  const removed = await deleteInactiveBuilderDraftsForMaintenance({ environment: process.env });
  console.log(JSON.stringify({ task: "builder-drafts-maintenance", removed }));
} catch {
  // Configuration/database errors can contain credentials. Keep operator logs
  // sanitized while making failure observable to the invoking scheduler.
  console.error("Builder draft maintenance failed.");
  process.exitCode = 1;
}
