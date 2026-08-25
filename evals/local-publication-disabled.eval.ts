import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description:
    "Eve reports local checkout publication as unavailable when the host capability is disabled.",
  tags: ["disabled-local-publication"],
  async test(t) {
    await t.send("What are your app builder capabilities?");
    t.succeeded();
    t.check(t.reply, includes("Local checkout publication is disabled"));
    t.notCalledTool("publish_reviewed_change_set");
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
