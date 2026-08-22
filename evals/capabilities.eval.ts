import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description:
    "The real Eve session surface explains the builder's approval-separated workflow.",
  async test(t) {
    await t.send("What are your app builder capabilities?");
    t.succeeded();
    t.check(t.reply, includes("prepare its exact reviewed tree read-only"));
    t.check(t.reply, includes("publication"));
    t.check(t.reply, includes("not implemented yet"));
  },
});
