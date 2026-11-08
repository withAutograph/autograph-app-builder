/* oxlint-disable sonarjs/expression-complexity -- Keep each exact immutable binding comparison visible at the read-only authority boundary. */
import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import { applicationFilePathSchema } from "../repository/application-file-change";
import {
  EVE_NATIVE_RESULT_PAGE_BYTES,
  largestUtf8PayloadChunk,
  serializedPayloadBytes,
} from "../eve/payload-envelope";
import { appBuilderWorkflowState, sha256 } from "./workflow-state";
import { readPrivateApplyAuthority } from "./private-apply-authority";
import { existingAppRepairHistory } from "./existing-app-repair-planning";

export interface ProposedSourceInspectionInput {
  appId: string;
  expectedProposalDigest?: string;
  paths: string[];
  contentPath?: string;
  expectedDigest?: string;
  offsetBytes?: number;
  pathIndex: number;
}
interface File {
  path: string;
  operation: "upsert" | "delete";
  digest?: string;
  mode?: string;
  beforeDigest?: string;
  content?: string;
  offsetBytes?: number;
}
interface Output {
  appId: string;
  source: "current-proposal";
  status: "UNAPPLIED";
  proposalDigest: string;
  iterationDigest: string;
  files: File[];
  availablePaths?: string[];
  nextPathIndex?: number;
  missingPaths?: string[];
  continuation?: { path: string; digest: string; offsetBytes: number };
}
const denied = () =>
  new Error(
    "The current unapplied proposal source no longer matches this session, app or digest. Inspect the current plan before retrying.",
  );
const event = (output: Output) => ({
  type: "action.result",
  data: { result: { kind: "tool-result", output, toolName: "inspect_existing_app" } },
});

/** Session-scoped frozen model-authored bytes only. Never acquires or reads a Sandbox. */
// oxlint-disable-next-line eslint/complexity -- Keep the exact proposal and session checks together before reading draft bytes.
const bindCurrentProposalSource = (
  input: ProposedSourceInspectionInput,
  ctx: Pick<ToolContext, "session" | "abortSignal">,
) => {
  ctx.abortSignal?.throwIfAborted();
  const current = appBuilderWorkflowState.get();
  const authority = readPrivateApplyAuthority();
  const history = existingAppRepairHistory.get();
  if (
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(input.appId) ||
    current.phase !== "planned" ||
    current.appSpec.appId !== input.appId ||
    (input.expectedProposalDigest !== undefined &&
      current.proposal.digest !== input.expectedProposalDigest) ||
    (input.expectedProposalDigest === undefined &&
      (input.pathIndex > 0 || (input.offsetBytes ?? 0) > 0)) ||
    !("iteration" in current.proposal.target) ||
    current.proposal.target.operation !== "iterate-existing-app"
  ) {
    throw denied();
  }
  const { proposal } = current;
  const { digest, ...unsigned } = proposal;
  const { target } = current.proposal;
  if (
    !ctx.session.id ||
    proposal.plannedByCallId.length === 0 ||
    sha256(JSON.stringify(unsigned)) !== digest ||
    proposal.appSpecDigest !== current.appSpec.digest ||
    proposal.workspaceDigest !== current.workspace.workspaceDigest ||
    proposal.sourceReceiptDigest !== current.sourceReceipt.digest ||
    target.contract.appId !== input.appId ||
    target.contract.appSpec.sha256 !== current.appSpec.digest ||
    proposal.contractDigest !== sha256(JSON.stringify(target.contract)) ||
    sha256(JSON.stringify(target.iteration.changes)) !== target.iteration.digest ||
    authority.grant?.proposalDigest === digest ||
    history.some(
      (entry) => entry.proposalDigest === digest && entry.sessionId !== ctx.session.id,
    ) ||
    authority.pending.some(
      ({ scope }) =>
        scope.proposalDigest === digest &&
        (scope.sessionId !== ctx.session.id ||
          scope.appId !== input.appId ||
          scope.appSpecDigest !== current.appSpec.digest ||
          scope.workspaceId !== current.workspace.workspaceId),
    )
  ) {
    throw denied();
  }
  return { proposal, target };
};

type Changes = ReturnType<typeof bindCurrentProposalSource>["target"]["iteration"]["changes"];
const validateProposalChanges = (changes: Changes, prefix: string) => {
  const paths = new Set<string>();
  for (const change of changes) {
    if (
      !applicationFilePathSchema.safeParse(change.path).success ||
      !change.path.startsWith(prefix) ||
      paths.has(change.path) ||
      (change.after === undefined && change.before === undefined) ||
      (change.after !== undefined &&
        createHash("sha256").update(change.after.content, "utf-8").digest("hex") !==
          change.after.digest)
    ) {
      throw denied();
    }
    paths.add(change.path);
  }
  return paths;
};
const appendProposalPathListing = (output: Output, paths: Set<string>, pathIndex: number) => {
  const fits = () => serializedPayloadBytes(event(output)) <= EVE_NATIVE_RESULT_PAGE_BYTES;
  const available = [...paths].toSorted();
  output.availablePaths = [];
  let index = pathIndex;
  while (index < available.length) {
    const path = available[index];
    if (path === undefined) {
      break;
    }
    output.availablePaths.push(path);
    output.nextPathIndex = index + 1;
    if (!fits()) {
      output.availablePaths.pop();
      break;
    }
    index += 1;
  }
  if (index < available.length && output.availablePaths.length === 0) {
    throw new Error("The proposal path cannot fit within the source inspection envelope.");
  }
  if (index < available.length) {
    output.nextPathIndex = index;
  } else {
    delete output.nextPathIndex;
  }
};
const requestedProposalPath = (requested: string, prefix: string) => {
  if (
    !applicationFilePathSchema.safeParse(requested).success ||
    (requested.startsWith("apps/") && !requested.startsWith(prefix))
  ) {
    throw denied();
  }
  return requested.startsWith(prefix) ? requested : `${prefix}${requested}`;
};
const appendProposalFiles = (
  output: Output,
  changeByPath: Map<string, Changes[number]>,
  selected: string[],
  input: ProposedSourceInspectionInput,
  prefix: string,
) => {
  for (const requested of selected) {
    const path = requestedProposalPath(requested, prefix);
    const change = changeByPath.get(path);
    if (change === undefined) {
      output.missingPaths ??= [];
      output.missingPaths.push(path);
      continue;
    }
    if (change.after === undefined) {
      if (input.expectedDigest !== undefined || (input.offsetBytes ?? 0) > 0) {
        throw denied();
      }
      output.files.push({
        path,
        operation: "delete",
        beforeDigest: change.before?.digest,
        mode: change.before?.mode,
      });
      continue;
    }
    const { content, digest: fileDigest, mode } = change.after;
    if (
      input.contentPath !== undefined &&
      input.expectedDigest !== undefined &&
      input.expectedDigest !== fileDigest
    ) {
      throw denied();
    }
    const offsetBytes = input.contentPath === undefined ? 0 : (input.offsetBytes ?? 0);
    if (content === "" && offsetBytes === 0) {
      output.files.push({
        path,
        operation: "upsert",
        digest: fileDigest,
        mode,
        content,
        offsetBytes,
      });
      continue;
    }
    const chunk = largestUtf8PayloadChunk({
      maxBytes: EVE_NATIVE_RESULT_PAGE_BYTES,
      content,
      offsetBytes,
      makePayload: (part, next) =>
        event({
          ...output,
          files: [
            ...output.files,
            { path, operation: "upsert", digest: fileDigest, mode, content: part, offsetBytes },
          ],
          ...(next < Buffer.byteLength(content)
            ? { continuation: { path, digest: fileDigest, offsetBytes: next } }
            : {}),
        }),
    });
    output.files.push({
      path,
      operation: "upsert",
      digest: fileDigest,
      mode,
      content: chunk.content,
      offsetBytes,
    });
    if (chunk.nextOffsetBytes < Buffer.byteLength(content)) {
      output.continuation = { path, digest: fileDigest, offsetBytes: chunk.nextOffsetBytes };
      break;
    }
  }
};

const renderCurrentProposalSource = (
  input: ProposedSourceInspectionInput,
  binding: ReturnType<typeof bindCurrentProposalSource>,
): Output => {
  const { proposal, target } = binding;
  const { digest } = proposal;
  const prefix = `apps/${input.appId}/`;
  const { changes } = target.iteration;
  const paths = validateProposalChanges(changes, prefix);
  const output: Output = {
    appId: input.appId,
    source: "current-proposal",
    status: "UNAPPLIED",
    proposalDigest: digest,
    iterationDigest: target.iteration.digest,
    files: [],
  };
  const fits = () => serializedPayloadBytes(event(output)) <= EVE_NATIVE_RESULT_PAGE_BYTES;
  const changeByPath = new Map(changes.map((change) => [change.path, change]));
  const selected = input.contentPath === undefined ? input.paths : [input.contentPath];
  if (selected.length === 0) {
    appendProposalPathListing(output, paths, input.pathIndex);
  } else {
    appendProposalFiles(output, changeByPath, selected, input, prefix);
  }
  if (!fits()) {
    throw new Error("Request fewer proposal paths to stay within the source inspection envelope.");
  }
  return output;
};

/** A current proposal is a read-only draft, never the applied app or an approval. */
export const inspectCurrentProposalSource = (
  input: ProposedSourceInspectionInput,
  ctx: Pick<ToolContext, "session" | "abortSignal">,
): Output => {
  const binding = bindCurrentProposalSource(input, ctx);
  return renderCurrentProposalSource(input, binding);
};
