import { createAutomaticPreviewObserver } from "../evals/support/self-reproduction-auto-preview";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import pathModule from "node:path";

import { parseArgs } from "node:util";
import {
  makePublicTransport,
  publicObservationReport,
  recordPublicObservation,
  sanitizePublicObservation,
  runPublicSession,
  validatePublicEndpoint,
} from "../evals/support/self-reproduction-public.ts";
import type { PublicState, Responses } from "../evals/support/self-reproduction-public.ts";

const { isAbsolute, relative, resolve } = pathModule;
const { values } = parseArgs({
  options: {
    endpoint: { type: "string" },
    help: { type: "boolean" },
    "message-file": { type: "string" },
    "no-preview-observation": { default: false, type: "boolean" },
    "output-dir": { type: "string" },
    "poll-ms": { default: "2000", type: "string" },
    "responses-file": { type: "string" },
    resume: { default: false, type: "boolean" },
    "timeout-ms": { default: "120000", type: "string" },
  },
  strict: true,
});
if (values.help) {
  console.log(
    "Submit the fixed product brief through public MCP. --endpoint URL --output-dir PATH [--resume] [--responses-file PATH | --message-file PATH] [--timeout-ms 120000] [--poll-ms 2000]. Responses file is an array of exact {requestId,response} entries. No approvals are inferred. Resume uses the same session and idempotency keys. Comparison remains separate. Preview capture starts automatically; --no-preview-observation disables it.",
  );
  process.exit(0);
}
if (!values.endpoint || !values["output-dir"]) {
  throw new Error("--endpoint and --output-dir are required");
}
if (values["message-file"] && !values.resume) {
  throw new Error("--message-file requires --resume");
}
validatePublicEndpoint(values.endpoint);
const repo = realpathSync(resolve(import.meta.dirname, ".."));
const output = resolve(values["output-dir"]);
let existingParent = output;
while (!existsSync(existingParent)) {
  existingParent = pathModule.dirname(existingParent);
}
const canonicalOutput = resolve(realpathSync(existingParent), relative(existingParent, output));
const distance = relative(repo, canonicalOutput);
if (
  !distance ||
  (distance !== ".." && !distance.startsWith(`..${pathModule.sep}`) && !isAbsolute(distance))
) {
  throw new Error("Evidence must be outside the reference source tree");
}
mkdirSync(output, { mode: 0o700, recursive: true });
const timeoutMs = Number(values["timeout-ms"]);
const pollMs = Number(values["poll-ms"]);
if (
  !Number.isSafeInteger(timeoutMs) ||
  timeoutMs <= 0 ||
  !Number.isSafeInteger(pollMs) ||
  pollMs <= 0
) {
  throw new Error("Timeout and polling interval must be positive integer milliseconds");
}
const path = resolve(output, "state.json");
if (existsSync(path) !== values.resume) {
  throw new Error(
    "Use a new output directory for one baseline, or --resume for its existing state",
  );
}
const state: PublicState = values.resume
  ? (JSON.parse(readFileSync(path, "utf-8")) as PublicState)
  : {
      answered: [],
      clientRequestId: randomUUID(),
      endpoint: values.endpoint,
      outcome: "starting",
      prompt: readFileSync(resolve(repo, "evals/self-reproduction/brief.md"), "utf-8"),
      startedAt: new Date().toISOString(),
      version: 1,
    };
state.promptSha256 = createHash("sha256").update(state.prompt).digest("hex");
if (!state.sourceRevision) {
  try {
    state.sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf-8",
    }).trim();
  } catch {
    state.sourceRevision = "unavailable";
  }
}
if (state.endpoint !== values.endpoint) {
  throw new Error("Resume must use the original endpoint");
}
const observer = values["no-preview-observation"]
  ? undefined
  : createAutomaticPreviewObserver({ outputDir: output, repositoryRoot: repo });
observer?.observe(state);
const previewMarkdown = observer
  ? "[Automatic preview observations](preview-observations/index.html) · [Runner ledger](preview-observations/ledger.json)"
  : "Automatic preview observation disabled; browser comparison remains unassessed.";
const previewHtml = observer
  ? '<a href="preview-observations/index.html">Automatic preview observations</a> · <a href="preview-observations/ledger.json">Runner ledger</a>'
  : "Automatic preview observation disabled; browser comparison remains unassessed.";
observer?.observe(state);
const save = () => {
  // Private continuation state preserves exact request IDs and pending replies; public reports are sanitized.
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
  const report = publicObservationReport(state);
  const json = JSON.stringify(report, null, 2);
  writeFileSync(resolve(output, "report.json"), json, { mode: 0o600 });
  writeFileSync(
    resolve(output, "report.md"),
    `# Public App Builder observation\n\nOutcome: ${state.outcome}\n\n${previewMarkdown}\n\nComparison: unassessed. A completed session is not proof of successful self-reproduction.\n\n\`\`\`json\n${json}\n\`\`\`\n`,
    { mode: 0o600 },
  );
  const escaped = json.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  writeFileSync(
    resolve(output, "index.html"),
    `<!doctype html><meta charset="utf-8"><title>Public App Builder observation</title><h1>Public App Builder observation</h1><p>${previewHtml}</p><p>Comparison remains unassessed. Completed session does not establish successful self-reproduction.</p><pre>${escaped}</pre>`,
    { mode: 0o600 },
  );
};
save();
try {
  const transport = await makePublicTransport(
    values.endpoint,
    (record) => recordPublicObservation(output, record),
    timeoutMs,
  );
  const responses = values["responses-file"]
    ? (JSON.parse(readFileSync(values["responses-file"], "utf-8")) as Responses)
    : undefined;
  const message = values["message-file"]
    ? readFileSync(values["message-file"], "utf-8")
    : undefined;
  await runPublicSession({
    message,
    onObservation: observer?.observe,
    pollMs,
    responses,
    save,
    state,
    timeoutMs,
    transport,
  });
} catch (error) {
  state.outcome = "blocked_transport_or_contract";
  state.error = String(sanitizePublicObservation(String(error)));
  save();
  recordPublicObservation(output, { error: String(error) });
  console.error(sanitizePublicObservation(String(error)));
  process.exitCode = 1;
} finally {
  await observer?.finish();
}
console.log(`Public eval ${state.outcome}; report: ${resolve(output, "index.html")}`);
