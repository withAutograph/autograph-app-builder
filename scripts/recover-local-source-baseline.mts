import { readFile } from "node:fs/promises";
import {
  localSourceRecoveryRequestSchema,
  recoverLocalSourceBaseline,
} from "../lib/repository/recover-local-source-baseline";

const args = process.argv.slice(2);
const values = new Map<string, string>();
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (
    flag === undefined ||
    value === undefined ||
    !["--runs-root", "--request"].includes(flag) ||
    values.has(flag)
  ) {
    throw new Error("Expected unique --runs-root and --request arguments");
  }
  values.set(flag, value);
}
const runsRoot = values.get("--runs-root");
const requestFile = values.get("--request");
if (runsRoot === undefined || requestFile === undefined) {
  throw new Error(
    "Usage: source:recover-local-baseline -- --runs-root /existing/instance/state/runs --request /reviewed/source-only-request.json",
  );
}
const result = await recoverLocalSourceBaseline({
  request: localSourceRecoveryRequestSchema.parse(JSON.parse(await readFile(requestFile, "utf-8"))),
  runsRoot,
});
console.log(
  JSON.stringify({
    originalSourceSha: result.manifest.originalSourceSha,
    root: result.root,
    sourceSha: result.manifest.sourceSha,
    sourceTree: result.manifest.sourceTree,
    workspaceDigest: result.manifest.workspaceDigest,
  }),
);
