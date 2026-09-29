import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

export default defineEval({
  description:
    "The fresh-bootstrap profile explains product capabilities without exposing setup mechanics.",
  tags: ["fresh-bootstrap-publication"],
  async test(t) {
    const session = await t.session();
    const turn = await session.send("What are your app builder capabilities?");
    t.succeeded();
    t.check(turn.message, includes("usable visual prototype"));
    t.check(turn.message, includes("infer sensible names, routes, roles"));
    t.check(turn.message, includes("materially change the product"));
    t.check(turn.message, includes("publish, deploy, release"));
    t.check(
      turn.message,
      satisfies(
        (reply) =>
          typeof reply === "string" &&
          !/(?:fresh local bootstrap|exact absent or exact-empty destination|configures a remote|source receipt|isolated App Builder workspace)/iu.test(
            reply,
          ),
        "capability reply omits fresh-bootstrap, source, workspace, and remote-configuration mechanics",
      ),
    );
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
