import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { isProductFacing } from "./support/public-conversation";

export default defineEval({
  description:
    "A materially ambiguous brief asks one product-domain question with a visible tradeoff and recommended default.",
  async test(t) {
    const session = await t.session();
    let turn: EveEvalTurn;
    turn = await session.send(
      "Uncertain vendor workflow brief: We need an internal vendor product, but we do not know whether it should focus on initial onboarding or ongoing compliance monitoring.",
    );

    t.succeeded();
    t.usedNoTools();
    t.notEvent("input.requested");
    t.check(turn.message, includes("meaningfully different products"));
    t.check(turn.message, includes("getting each new vendor approved once"));
    t.check(turn.message, includes("recommended"));
    t.check(turn.message, includes("continuously monitoring vendors"));
    t.check(
      turn.message,
      satisfies(
        (reply) => isProductFacing(reply) && String(reply).endsWith("?"),
        "the only question is product-facing and recommends a default",
      ),
    );
  },
});
