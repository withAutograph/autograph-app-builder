import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

import { createSupportedRepositoryFixture } from "./support/supported-repository";

export default defineEval({
  description: "A fresh-template SHA change invalidates pending acquisition.",
  async test(t) {
    const repository = createSupportedRepositoryFixture();
    await t.send(`Prepare fresh template at ${repository}`);
    t.requireInputRequest({ toolName: "approve_source_acquisition" });
    writeFileSync(join(repository, "README.md"), "source drift\n");
    execFileSync("git", ["add", "README.md"], { cwd: repository });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-m",
        "drift",
      ],
      { cwd: repository },
    );
    await t.respondAll("approve");
    t.succeeded();
    t.calledTool("prepare_workspace", { count: 0 });
    t.notCalledTool("bash");
    t.notCalledTool("write_file");
    t.check(t.reply, includes("became stale"));
  },
});
