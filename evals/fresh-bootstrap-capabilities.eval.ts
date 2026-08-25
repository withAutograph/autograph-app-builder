import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  tags: ["fresh-bootstrap-publication"],
  description:
    "Eve honestly reports the configured fresh local bootstrap capability.",
  async test(t) {
    await t.send("What are your app builder capabilities?");
    t.succeeded();
    t.check(t.reply, includes("fresh local bootstrap is enabled"));
    t.check(t.reply, includes("exact absent or exact-empty destination"));
    t.check(t.reply, includes("never configures a remote"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
