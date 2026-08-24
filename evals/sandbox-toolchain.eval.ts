import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  description:
    "The Eve agent reports the fixed sandbox toolchain allowlist without mutating it.",
  async test(t) {
    await t.send("Inspect the sandbox toolchain.");
    t.succeeded();
    t.calledTool("inspect_sandbox_toolchain", { count: 1 });
    t.check(t.reply, includes("Sandbox toolchain receipt"));
    t.check(t.reply, includes("unconfigured"));
    t.check(t.reply, includes('toolchainReady":false'));
    t.check(t.reply, includes("toolchainReady"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
