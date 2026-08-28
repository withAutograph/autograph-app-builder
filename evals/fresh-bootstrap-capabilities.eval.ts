import { defineEval } from "eve/evals";
import { includes, satisfies } from "eve/evals/expect";

export default defineEval({
  tags: ["fresh-bootstrap-publication"],
  description:
    "The fresh-bootstrap profile explains product capabilities without exposing setup mechanics.",
  async test(t) {
    await t.send("What are your app builder capabilities?");
    t.succeeded();
    t.check(t.reply, includes("usable visual prototype"));
    t.check(t.reply, includes("infer sensible names, routes, roles"));
    t.check(t.reply, includes("materially change the product"));
    t.check(t.reply, includes("publish, deploy, release"));
    t.check(
      t.reply,
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
