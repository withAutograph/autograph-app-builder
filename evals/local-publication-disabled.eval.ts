import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "A publication-disabled host offers useful product outcomes without exposing host mechanics.",
  tags: ["disabled-local-publication"],
  async test(t) {
    await t.send("What are your app builder capabilities?");
    t.succeeded();
    t.check(t.reply, includes("usable visual prototype"));
    t.check(t.reply, includes("reviewable implementation plan"));
    t.check(t.reply, includes("recommend the closest useful alternative"));
    t.check(
      t.reply,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          !/(?:local checkout publication is disabled|disabled on this host|host capability|APP_BUILDER_LOCAL_PUBLICATION)/iu.test(
            reply,
          ),
        "capability reply omits disabled-host and local-publication boilerplate",
      ),
    );
    t.notCalledTool("publish_reviewed_change_set");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
