import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";
import { z } from "zod";

export default defineEval({
  description:
    "A publication-disabled host offers useful product outcomes without exposing host mechanics.",
  tags: ["disabled-local-publication"],
  async test(t) {
    const session = await t.session();
    const turn = await session.send("What are your app builder capabilities?");
    t.succeeded();
    t.check(turn.message, includes("usable visual prototype"));
    t.check(turn.message, includes("reviewable implementation plan"));
    t.check(turn.message, includes("recommend the closest useful alternative"));
    t.check(
      turn.message,
      satisfies((reply) => {
        const parsedReply = z.string().safeParse(reply);
        return (
          parsedReply.success &&
          !/(?:local checkout publication is disabled|disabled on this host|host capability|APP_BUILDER_LOCAL_PUBLICATION)/iu.test(
            parsedReply.data,
          )
        );
      }, "capability reply omits disabled-host and local-publication boilerplate"),
    );
    t.notCalledTool("publish_reviewed_change_set");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
