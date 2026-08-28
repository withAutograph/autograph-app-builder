import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "One Eve input batch can approve three parallel prototype artifacts without losing state.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare supported repository at ${repository}`);
    t.requireInputRequest({ toolName: "prepare_workspace" });
    await t.respondAll("approve");
    t.succeeded();
    t.eventsSatisfy(
      "the durable input.resolved event settles the exact three-request batch",
      (events) => {
        const requested = events.find(
          (event) =>
            event.type === "input.requested" &&
            event.data.requests.length === 3,
        );
        if (requested?.type !== "input.requested") return false;
        const requestIds = requested.data.requests
          .map(({ requestId }) => requestId)
          .toSorted();
        return events.some(
          (event) =>
            event.type === "input.resolved" &&
            event.data.resolutions.length === 3 &&
            event.data.resolutions.every(
              ({ outcome }) => outcome === "approved",
            ) &&
            event.data.resolutions
              .map(({ requestId }) => requestId)
              .toSorted()
              .every((requestId, index) => requestId === requestIds[index]),
        );
      },
    );

    await t.send("Record three prototype artifacts in parallel.");
    await t.respondAll("approve");
    t.succeeded();
    t.calledTool("record_prototype_artifact", { count: 3 });
    t.check(t.reply, includes("All three prototype artifacts were recorded"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");

    await t.send("Report artifact workflow status.");
    t.succeeded();
    t.check(t.reply, includes("app-spec.md"));
    t.check(t.reply, includes("decisions.md"));
    t.check(t.reply, includes("index.html"));
  },
});
