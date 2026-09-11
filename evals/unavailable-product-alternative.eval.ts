import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { isProductFacing } from "./support/public-conversation";

export default defineEval({
  description:
    "An irreconcilable constraint is translated into an unavailable product outcome and a recommended product-level alternative.",
  async test(t) {
    await t.send(
      "Build an anonymous public vendor portal in this app where anyone can upload tax and banking documents without signing in.",
    );

    t.succeeded();
    t.usedNoTools();
    t.notEvent("input.requested");
    t.check(t.reply, includes("anonymous public vendor portal is unavailable"));
    t.check(t.reply, includes("recommended alternative"));
    t.check(t.reply, includes("internal **Vendor Intake** experience"));
    t.check(t.reply, includes("secure upload requests"));
    t.check(
      t.reply,
      satisfies(
        (reply) => isProductFacing(reply) && !String(reply).includes("?"),
        "the limitation and alternative remain product-facing without an unresolvable question",
      ),
    );
  },
});
