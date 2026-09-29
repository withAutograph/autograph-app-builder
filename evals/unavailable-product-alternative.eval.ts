import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

import { isProductFacing } from "./support/public-conversation";

export default defineEval({
  description:
    "An irreconcilable constraint is translated into an unavailable product outcome and a recommended product-level alternative.",
  async test(t) {
    const session = await t.session();
    let turn: EveEvalTurn;
    turn = await session.send(
      "Build an anonymous public vendor portal in this app where anyone can upload tax and banking documents without signing in.",
    );

    t.succeeded();
    t.usedNoTools();
    t.notEvent("input.requested");
    t.check(turn.message, includes("anonymous public vendor portal is unavailable"));
    t.check(turn.message, includes("recommended alternative"));
    t.check(turn.message, includes("internal **Vendor Intake** experience"));
    t.check(turn.message, includes("secure upload requests"));
    t.check(
      turn.message,
      satisfies(
        (reply) => isProductFacing(reply) && !String(reply).includes("?"),
        "the limitation and alternative remain product-facing without an unresolvable question",
      ),
    );
  },
});
