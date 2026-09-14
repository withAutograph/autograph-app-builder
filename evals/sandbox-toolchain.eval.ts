import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description:
    "The Eve agent reports the current Vercel development Sandbox and prepared toolchain without mutating it.",
  tags: ["sandbox-toolchain", "sandbox-integration"],
  async test(t) {
    await t.send("Inspect the sandbox toolchain.");
    t.succeeded();
    t.calledTool("inspect_sandbox_toolchain", { count: 1 });
    t.check(t.reply, includes("Sandbox toolchain receipt"));
    t.check(t.reply, includes('"backend":"vercel-development"'));
    t.check(t.reply, includes('"toolchainReady":true'));
    t.check(t.reply, includes("toolchainReady"));
    t.check(t.reply, includes("backend"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
