import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

export default defineEval({
  tags: ["sandbox-toolchain"],
  description:
    "The Eve agent reports the fixed sandbox toolchain allowlist without mutating it.",
  async test(t) {
    const configured = process.env.APP_BUILDER_SANDBOX_IMAGE !== undefined;
    await t.send("Inspect the sandbox toolchain.");
    t.succeeded();
    t.calledTool("inspect_sandbox_toolchain", { count: 1 });
    t.check(t.reply, includes("Sandbox toolchain receipt"));
    t.check(t.reply, includes(configured ? "configured" : "unconfigured"));
    t.check(
      t.reply,
      includes(`toolchainReady":${configured ? "true" : "false"}`),
    );
    t.check(t.reply, includes("toolchainReady"));
    t.check(t.reply, includes("backend"));
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
  },
});
