import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { BUILD_READY_APP_SPEC } from "./support/app-spec";
import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description:
    "Read-only target identity and planning complete automatically without a user-input prompt.",
  async test(t) {
    const session = await t.session();
    const repository = createSupportedRepositoryFixture();
    await session.send(`Prepare supported repository at ${repository}`);
    await session.send(`Accept build-ready AppSpec for expense-review:\n${BUILD_READY_APP_SPEC}`);
    t.succeeded();
    await session.send("Prepare offline target dependencies.");
    t.succeeded();
    const turn1 = await session.send("Run target identity and planning.");
    t.succeeded();
    t.notEvent("input.requested");
    t.check(turn1.message, includes("private preview"));
    t.check(
      turn1.message,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          !/canonical proposal|digest-bound|target identity|target mutation/iu.test(reply),
        "automatic planning stays product-facing",
      ),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    const turn2 = await session.send("Report artifact workflow status.");
    t.succeeded();
    t.check(turn2.message, includes('"phase":"planned"'));
  },
});
