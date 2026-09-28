import { defineSchedule } from "eve/schedules";

import { retryDueProvisioningDeployment } from "@/lib/hosted/provisioning-retry-deployment";

export default defineSchedule({
  cron: "* * * * *",
  run({ waitUntil }) {
    waitUntil(retryDueProvisioningDeployment(process.env));
  },
});
