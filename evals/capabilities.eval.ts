import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description:
    "The real Eve session surface explains the builder's approval-separated workflow.",
  async test(t) {
    await t.send("What are your app builder capabilities?");
    t.succeeded();
    t.check(t.reply, includes("isolated supported repository workspace"));
    t.check(t.reply, includes("publish only after a separate approval"));
  },
});
