import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { isProductFacing } from "./support/public-conversation";

export default defineEval({
  description:
    "A materially ambiguous brief asks one product-domain question with a visible tradeoff and recommended default.",
  async test(t) {
    await t.send(
      "Uncertain vendor workflow brief: We need an internal vendor product, but we do not know whether it should focus on initial onboarding or ongoing compliance monitoring.",
    );

    t.succeeded();
    t.usedNoTools();
    t.notEvent("input.requested");
    t.check(t.reply, includes("meaningfully different products"));
    t.check(t.reply, includes("getting each new vendor approved once"));
    t.check(t.reply, includes("recommended"));
    t.check(t.reply, includes("continuously monitoring vendors"));
    t.check(
      t.reply,
      satisfies(
        (reply) => isProductFacing(reply) && String(reply).endsWith("?"),
        "the only question is product-facing and recommends a default",
      ),
    );
  },
});
