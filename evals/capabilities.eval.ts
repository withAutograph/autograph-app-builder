import { defineEval, type EveEvalTurn } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description:
    "The builder explains its capabilities in product language and reserves approval for outward effects.",
  async test(t) {
    const session = await t.session();
    let turn: EveEvalTurn;
    turn = await session.send("What are your app builder capabilities?");
    t.succeeded();
    t.check(turn.message, includes("usable visual prototype"));
    t.check(turn.message, includes("infer sensible names, routes, roles"));
    t.check(turn.message, includes("materially change the product"));
    t.check(turn.message, includes("publish, deploy, release"));
  },
});
