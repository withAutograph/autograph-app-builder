import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

import { sha256 } from "@/lib/agent/workflow-state";
import { hasTestCapability } from "@/lib/testing/test-capability";

const vendorOnboardingPrototype = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Vendor Onboarding</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; color: #17211b; background: #f4f7f4; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { padding: 24px 32px 18px; background: #173f31; color: white; }
    header p { margin: 6px 0 0; color: #c8ddd4; }
    main { display: grid; grid-template-columns: minmax(320px, 0.9fr) minmax(380px, 1.1fr); gap: 20px; padding: 24px 32px; }
    section { background: white; border: 1px solid #dce5df; border-radius: 16px; box-shadow: 0 8px 24px #163b2d12; }
    .section-heading { padding: 18px 20px; border-bottom: 1px solid #e6ece8; }
    h1, h2, h3, p { margin-top: 0; }
    h1 { margin-bottom: 0; font-size: 24px; }
    h2 { margin-bottom: 4px; font-size: 17px; }
    .muted { color: #617067; font-size: 14px; }
    .filters { display: flex; gap: 8px; padding: 14px 20px; }
    button { border: 1px solid #c8d4cd; border-radius: 999px; background: white; color: #244438; padding: 8px 12px; font: inherit; cursor: pointer; }
    button[aria-pressed="true"] { background: #d9eee4; border-color: #74a88f; }
    .queue { list-style: none; margin: 0; padding: 0 12px 14px; }
    .queue button { width: 100%; border: 0; border-radius: 12px; padding: 14px 12px; display: grid; grid-template-columns: 1fr auto; gap: 6px 12px; text-align: left; }
    .queue button:hover, .queue button[aria-current="true"] { background: #edf6f1; }
    .queue strong { font-size: 15px; }
    .status { align-self: center; color: #8a4c10; background: #fff1db; border-radius: 999px; padding: 4px 8px; font-size: 12px; }
    .detail { padding: 20px; }
    .facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 18px 0; }
    .fact { padding: 12px; background: #f5f8f6; border-radius: 10px; }
    .fact span { display: block; color: #617067; font-size: 12px; margin-bottom: 3px; }
    .steps { list-style: none; margin: 0; padding: 0; }
    .steps li { position: relative; padding: 12px 12px 12px 42px; border-top: 1px solid #edf1ee; }
    .steps li::before { content: ""; position: absolute; left: 14px; top: 15px; width: 16px; height: 16px; border: 2px solid #77a28e; border-radius: 50%; }
    .steps li.done::before { background: #2d7557; border-color: #2d7557; box-shadow: inset 0 0 0 3px white; }
    .steps li.conditional { background: #fff9ee; }
    .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
    .primary { background: #1f684d; border-color: #1f684d; color: white; }
    @media (max-width: 760px) { main { grid-template-columns: 1fr; padding: 16px; } header { padding: 20px 16px; } .facts { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header><h1>Vendor Onboarding</h1><p>Review new vendors, resolve exceptions, and send complete records forward.</p></header>
  <main>
    <section aria-labelledby="queue-title">
      <div class="section-heading"><h2 id="queue-title">Operations review queue</h2><p class="muted">3 vendors need attention</p></div>
      <div class="filters" aria-label="Queue filters"><button aria-pressed="true">Needs review</button><button aria-pressed="false">Waiting</button><button aria-pressed="false">Ready</button></div>
      <ul class="queue">
        <li><button aria-current="true" data-name="Northstar Logistics" data-type="US corporation" data-tax="required"><strong>Northstar Logistics</strong><span class="status">Tax check</span><span class="muted">Submitted 2h ago</span></button></li>
        <li><button data-name="Cedar Creative Studio" data-type="US individual" data-tax="required"><strong>Cedar Creative Studio</strong><span class="status">Missing W-9</span><span class="muted">Submitted yesterday</span></button></li>
        <li><button data-name="Kiteworks GmbH" data-type="International company" data-tax="not-required"><strong>Kiteworks GmbH</strong><span class="status">Bank review</span><span class="muted">Submitted yesterday</span></button></li>
      </ul>
    </section>
    <section aria-labelledby="detail-title">
      <div class="section-heading"><h2 id="detail-title">Northstar Logistics</h2><p class="muted" id="vendor-type">US corporation</p></div>
      <div class="detail">
        <div class="facts"><div class="fact"><span>Requested by</span>Field Operations</div><div class="fact"><span>Risk tier</span>Standard</div></div>
        <h3>Review steps</h3>
        <ol class="steps"><li class="done">Business details complete</li><li class="done">Payment contact verified</li><li class="conditional" id="tax-step"><strong>Finance: verify tax information</strong><br><span class="muted">Required for tax-reportable US vendors</span></li><li>Final operations approval</li></ol>
        <div class="actions"><button>Request changes</button><button class="primary">Send to finance</button></div>
      </div>
    </section>
  </main>
  <script>
    const rows = document.querySelectorAll('.queue button');
    rows.forEach((row) => row.addEventListener('click', () => {
      rows.forEach((candidate) => candidate.removeAttribute('aria-current'));
      row.setAttribute('aria-current', 'true');
      document.querySelector('#detail-title').textContent = row.dataset.name;
      document.querySelector('#vendor-type').textContent = row.dataset.type;
      document.querySelector('#tax-step').hidden = row.dataset.tax !== 'required';
    }));
  </script>
</body>
</html>`;

const vendorOnboardingDecisions = `# Vendor Onboarding decisions

- \`agent_inferred\`: The product name is **Vendor Onboarding** and the app id is \`vendor-onboarding\`.
- \`agent_inferred\`: Operations starts from a review queue because the job is to move multiple submissions through exceptions efficiently.
- \`agent_inferred\`: Selecting a vendor opens an in-context detail panel so reviewers keep their queue position.
- \`agent_inferred\`: Finance tax verification appears only for tax-reportable vendors; other vendors skip that step.
- \`deferred\`: Final tax rules, approval roles, and system-of-record integrations remain product-review decisions.
`;

const vendorOnboardingAppSpec = `## Status and prototype

Exploring. The usable prototype is at prototype/vendor-onboarding/index.html.

## User and outcome

Operations reviewers move submitted vendors through exceptions to a complete handoff.

## Interfaces and navigation

An operations review queue opens an in-context vendor detail panel.

## Controls and behavior

Queue filters and vendor selection are interactive. Review actions remain provisional.

## Data model

Vendor submissions, review steps, exceptions, and accountable teams are provisional objects.

## Integrations and reconciliation

Tax and payment systems are deferred until product review.

## Temporal semantics

Submission age is visible; effective dating is unresolved.

## Writes, review, and authority

The prototype shows reviewed handoffs and does not define production write authority.

## Access and tenancy

Operations and Finance roles are provisional and tenant-scoped.

## Agent behavior

The agent may summarize missing evidence but cannot approve vendors.

## Operational states

Needs-review, waiting, ready, missing-document, and conditional-step states are represented.

## Defaults, non-goals, and risks

The queue, detail panel, and conditional Finance step are revisable inferred defaults.

## Acceptance walkthrough

Review the queue, open each vendor, and confirm that tax verification appears only when required.
`;

const vendorOnboardingCompleteAppSpec = `${vendorOnboardingAppSpec}
## Build handoff

\`\`\`json
{
  "status": "build-ready",
  "owner": "operations",
  "schema": { "kind": "kernel" },
  "additionalPublicRoutes": [],
  "optionalCapabilities": {
    "integrations": [],
    "hostedResources": []
  }
}
\`\`\``;

const testModel = mockModel(({ lastUserMessage, toolResults }) => {
  const message = (lastUserMessage ?? "").toLowerCase();
  if (message.includes("uncertain vendor workflow brief"))
    return "These lead to meaningfully different products. Which outcome should lead the first version: getting each new vendor approved once (recommended, because it delivers the fastest operational value), or continuously monitoring vendors after approval (broader scope with recurring compliance work)?";
  if (message.includes("anonymous public vendor portal"))
    return "An anonymous public vendor portal is unavailable in this product path. The recommended alternative is an internal **Vendor Intake** experience with an operations review queue and vendor detail panel, paired with secure upload requests sent through your existing intake channel.";
  if (message.includes("internal vendor-onboarding workflow")) {
    const path = lastUserMessage?.match(
      /supported repository at (\/\S+)/iu,
    )?.[1];
    if (path === undefined)
      return "I need the supported project location before I can start this prototype.";
    const inspection = toolResults.find(
      ({ name }) => name === "inspect_source",
    );
    if (inspection === undefined)
      return {
        toolCalls: [
          {
            name: "inspect_source",
            input: { path, sourceKind: "existing-repository" },
          },
        ],
      };
    if (inspection.isError)
      return "I couldn't use this project because it is not currently eligible for app creation.";
    const source = inspection.output as { digest?: string } | undefined;
    const preparation = toolResults.find(
      ({ name }) => name === "prepare_workspace",
    );
    if (preparation === undefined) {
      if (source?.digest === undefined)
        return "I couldn't verify this project for app creation.";
      return {
        toolCalls: [
          {
            name: "prepare_workspace",
            input: { expectedSourceReceiptDigest: source.digest },
          },
        ],
      };
    }
    if (preparation.isError)
      return "The project changed while I was getting it ready, so I stopped before designing against stale information.";
    const artifacts = toolResults.filter(
      ({ name }) => name === "record_prototype_artifact",
    );
    const recordedPaths = new Set(
      artifacts.flatMap((artifact) => {
        const path = (artifact.output as { path?: string } | undefined)?.path;
        return artifact.isError || path === undefined ? [] : [path];
      }),
    );
    const missingArtifact = [
      {
        path: "prototype/vendor-onboarding/index.html",
        mediaType: "text/html" as const,
        content: vendorOnboardingPrototype,
      },
      {
        path: "prototype/vendor-onboarding/decisions.md",
        mediaType: "text/markdown" as const,
        content: vendorOnboardingDecisions,
      },
      {
        path: "prototype/vendor-onboarding/app-spec.md",
        mediaType: "text/markdown" as const,
        content: vendorOnboardingAppSpec,
      },
    ].find(({ path: artifactPath }) => !recordedPaths.has(artifactPath));
    if (missingArtifact !== undefined)
      return {
        toolCalls: [
          {
            name: "record_prototype_artifact",
            input: missingArtifact,
          },
        ],
      };
    if (artifacts.some(({ isError }) => isError))
      return "I couldn't finish the first prototype artifact, so I stopped without treating it as reviewable.";
    const appSpecArtifacts = artifacts.filter(
      (artifact) =>
        (artifact.output as { path?: string } | undefined)?.path ===
        "prototype/vendor-onboarding/app-spec.md",
    );
    const acceptanceResults = toolResults.filter(
      ({ name }) => name === "accept_app_spec",
    );
    const latestAcceptance = acceptanceResults.at(-1);
    const repairDiagnostic = (() => {
      if (
        latestAcceptance?.isError !== true ||
        typeof latestAcceptance.output !== "string"
      )
        return undefined;
      try {
        return JSON.parse(
          latestAcceptance.output.replace(/^Error:\s*/u, ""),
        ) as {
          code?: string;
          issues?: { code?: string }[];
        };
      } catch {
        return undefined;
      }
    })();
    if (
      latestAcceptance?.isError === true &&
      repairDiagnostic?.code === "app_spec_invalid" &&
      repairDiagnostic.issues?.some(
        ({ code }) =>
          code === "missing_heading" || code === "build_handoff_format",
      ) === true &&
      appSpecArtifacts.length === 1 &&
      acceptanceResults.length === 1
    )
      return {
        toolCalls: [
          {
            name: "record_prototype_artifact",
            input: {
              path: "prototype/vendor-onboarding/app-spec.md",
              mediaType: "text/markdown",
              content: vendorOnboardingCompleteAppSpec,
            },
          },
        ],
      };
    const currentAppSpec = appSpecArtifacts.at(-1)?.output as
      { digest?: string; revision?: string } | undefined;
    const workspace = preparation.output as
      | {
          sourceSha?: string;
          sourceTree?: string;
          eligibilityDigest?: string;
          workspaceDigest?: string;
        }
      | undefined;
    if (
      acceptanceResults.length < appSpecArtifacts.length &&
      currentAppSpec?.digest !== undefined &&
      currentAppSpec.revision !== undefined &&
      workspace?.sourceSha !== undefined &&
      workspace.sourceTree !== undefined &&
      workspace.eligibilityDigest !== undefined &&
      workspace.workspaceDigest !== undefined
    )
      return {
        toolCalls: [
          {
            name: "accept_app_spec",
            input: {
              appId: "vendor-onboarding",
              expectedArtifactDigest: currentAppSpec.digest,
              expectedArtifactRevision: currentAppSpec.revision,
              expectedSourceSha: workspace.sourceSha,
              expectedSourceTree: workspace.sourceTree,
              expectedEligibilityDigest: workspace.eligibilityDigest,
              expectedWorkspaceDigest: workspace.workspaceDigest,
            },
          },
        ],
      };
    if (latestAcceptance?.isError === true)
      return "One product decision is still too unclear to produce a reliable implementation plan.";
    const accepted = latestAcceptance?.output as
      { digest?: string } | undefined;
    if (accepted?.digest === undefined)
      return "The product direction is not complete enough to plan reliably yet.";
    const dependencies = toolResults.find(
      ({ name }) => name === "prepare_target_dependencies",
    );
    if (dependencies === undefined)
      return {
        toolCalls: [
          {
            name: "prepare_target_dependencies",
            input: { expectedAppSpecDigest: accepted.digest },
          },
        ],
      };
    if (dependencies.isError)
      return "This product direction cannot yet be planned with the available project capabilities.";
    const plan = toolResults.find(({ name }) => name === "plan_app_creation");
    if (plan === undefined)
      return {
        toolCalls: [
          {
            name: "plan_app_creation",
            input: { expectedAppSpecDigest: accepted.digest },
          },
        ],
      };
    if (plan.isError)
      return "A real project conflict prevents this product direction from becoming a reliable plan.";
    const planned = plan.output as { digest?: string } | undefined;
    const application = toolResults.find(
      ({ name }) => name === "apply_app_creation",
    );
    if (application === undefined) {
      if (planned?.digest === undefined)
        return "I couldn't safely prepare this product direction for review.";
      return {
        toolCalls: [
          {
            name: "apply_app_creation",
            input: { expectedProposalDigest: planned.digest },
          },
        ],
      };
    }
    if (application.isError)
      return "I couldn't finish assembling this product direction for review.";
    const applied = application.output as { digest?: string } | undefined;
    const validation = toolResults.find(
      ({ name }) => name === "validate_app_creation",
    );
    if (validation === undefined) {
      if (applied?.digest === undefined)
        return "I couldn't safely check the assembled app.";
      return {
        toolCalls: [
          {
            name: "validate_app_creation",
            input: { expectedApplyDigest: applied.digest },
          },
        ],
      };
    }
    if (validation.isError)
      return "The assembled app needs another revision before it is ready to review.";
    const validated = validation.output as { digest?: string } | undefined;
    const changeSet = toolResults.find(
      ({ name }) => name === "change_set_status",
    );
    if (changeSet === undefined) {
      if (validated?.digest === undefined)
        return "I couldn't safely prepare the completed app for review.";
      return {
        toolCalls: [
          {
            name: "change_set_status",
            input: { expectedValidationDigest: validated.digest },
          },
        ],
      };
    }
    if (changeSet.isError)
      return "I couldn't prepare the completed app changes for review.";
    const review = toolResults.find(({ name }) => name === "accept_change_set");
    if (review === undefined) {
      const changes = changeSet.output as
        | {
            digest?: string;
            approvedPaths?: readonly string[];
            changes?: readonly unknown[];
          }
        | undefined;
      if (
        changes?.digest === undefined ||
        changes.approvedPaths === undefined ||
        changes.changes === undefined
      )
        return "I couldn't safely prepare the completed app for review.";
      return {
        toolCalls: [
          {
            name: "accept_change_set",
            input: {
              changeSet: {
                digest: changes.digest,
                approvedPaths: changes.approvedPaths,
                changes: changes.changes,
              },
            },
          },
        ],
      };
    }
    if (review.isError)
      return "I couldn't finish preparing the completed app for review.";
    return "I inferred **Vendor Onboarding** with app ID `vendor-onboarding`. The interactive prototype now covers an operations review queue, an in-context vendor detail panel, and a conditional Finance verification step for tax-reportable vendors. The implementation plan and complete app changes passed their checks and are ready to review. If you want to continue, I can prepare a draft pull request for the repository.";
  }
  if (message.includes("record three prototype artifacts in parallel")) {
    const recorded = toolResults.filter(
      ({ name }) => name === "record_prototype_artifact",
    );
    if (recorded.length === 0)
      return {
        toolCalls: [
          {
            name: "record_prototype_artifact",
            input: {
              path: "prototype/parallel-proof/app-spec.md",
              mediaType: "text/markdown",
              content: "# Build handoff\n",
            },
          },
          {
            name: "record_prototype_artifact",
            input: {
              path: "prototype/parallel-proof/decisions.md",
              mediaType: "text/markdown",
              content: "# Decisions\n",
            },
          },
          {
            name: "record_prototype_artifact",
            input: {
              path: "prototype/parallel-proof/index.html",
              mediaType: "text/html",
              content: "<!doctype html><title>Proof</title>",
            },
          },
        ],
      };
    return recorded.length === 3 && recorded.every(({ isError }) => !isError)
      ? "All three prototype artifacts were recorded."
      : "The parallel prototype artifact batch did not settle atomically.";
  }
  if (message.includes("github publication status")) {
    const result = toolResults.at(-1);
    if (result?.name !== "github_publication_status")
      return { toolCalls: [{ name: "github_publication_status", input: {} }] };
    if (result.isError)
      return "The typed GitHub publication status could not be verified.";
    const status = result.output as
      | {
          enabled?: boolean;
          adapterConfigured?: boolean;
          genericShellAuthority?: boolean;
          liveGitHubCallsAvailable?: boolean;
          reason?: string;
        }
      | undefined;
    return status?.enabled === false &&
      status.adapterConfigured === false &&
      status.genericShellAuthority === false &&
      status.liveGitHubCallsAvailable === false
      ? `GitHub publication is fail-closed: ${status.reason ?? "no typed adapter is configured."}`
      : "GitHub publication status did not prove the required fail-closed boundary.";
  }
  if (message.includes("report artifact workflow status")) {
    const result = toolResults.at(-1);
    if (result?.name !== "artifact_workflow_status")
      return { toolCalls: [{ name: "artifact_workflow_status", input: {} }] };
    return result.isError
      ? "The artifact workflow status could not be verified."
      : `Artifact workflow status: ${JSON.stringify(result.output)}`;
  }
  if (message.includes("inspect existing vendor application")) {
    const inspections = toolResults.filter(
      ({ name }) => name === "inspect_existing_app",
    );
    const latest = inspections.at(-1);
    if (latest === undefined)
      return {
        toolCalls: [
          {
            name: "inspect_existing_app",
            input: { appId: "vendor", paths: [] },
          },
        ],
      };
    if (latest.isError)
      return "The existing Vendor application could not be inspected safely.";
    const result = latest.output as
      | {
          availablePaths?: readonly string[];
          files?: readonly { path: string; content: string }[];
        }
      | undefined;
    if ((result?.files?.length ?? 0) === 0) {
      const candidates = result?.availablePaths?.filter((candidate) =>
        /^apps\/vendor\/.+[.](?:ts|tsx|js|jsx)$/u.test(candidate),
      );
      const path =
        candidates?.find((candidate) =>
          /(?:^|\/)page[.]tsx$/u.test(candidate),
        ) ??
        candidates?.find((candidate) => /[.]tsx$/u.test(candidate)) ??
        candidates?.at(0);
      if (path === undefined)
        return "The existing Vendor application has no bounded source file suitable for iteration.";
      return {
        toolCalls: [
          {
            name: "inspect_existing_app",
            input: { appId: "vendor", paths: [path] },
          },
        ],
      };
    }
    return "The existing Vendor application is ready for a bounded product iteration.";
  }
  if (message.includes("retry target planning")) {
    const stale = message.includes("stale");
    const planResults = toolResults.filter(
      ({ name }) => name === "plan_app_creation",
    );
    const requiredResults = stale ? 3 : 2;
    const statusResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (
      statusResult === undefined ||
      (planResults.length < requiredResults &&
        toolResults.at(-1)?.name === "plan_app_creation")
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      { appSpec?: { digest?: string }; phase?: string } | undefined;
    if (status?.phase !== "planned" || status.appSpec?.digest === undefined)
      return "A completed target plan is required before retry.";
    const planResult = planResults.at(-1);
    if (planResults.length < requiredResults)
      return {
        toolCalls: [
          {
            name: "plan_app_creation",
            input: {
              expectedAppSpecDigest: stale
                ? "0".repeat(64)
                : status.appSpec.digest,
            },
          },
        ],
      };
    if (planResult === undefined)
      return "The target-planning retry result is unavailable.";
    if (planResult.isError)
      return "The stale target-planning retry was rejected without changing its durable receipt.";
    const output = planResult.output as { reused?: boolean } | undefined;
    return output?.reused === true
      ? "The lost-response retry reused the exact durable target-planning receipt without rerunning either target command."
      : "The target-planning retry did not reuse its durable receipt.";
  }
  if (message.includes("prepare offline target dependencies")) {
    const stale = message.includes("stale appspec digest");
    const lostResponse = message.includes("lost response");
    const statusResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    const observedPhase = (
      statusResult?.output as { phase?: string } | undefined
    )?.phase;
    if (
      statusResult === undefined ||
      (observedPhase !== "app_spec_accepted" &&
        observedPhase !== "dependencies_prepared" &&
        toolResults.at(-1)?.name !== "workspace_status")
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      { appSpec?: { digest?: string }; phase?: string } | undefined;
    if (
      status?.phase !== "app_spec_accepted" &&
      status?.phase !== "dependencies_prepared"
    )
      return "An accepted AppSpec is required before dependency preparation.";
    if (status.appSpec?.digest === undefined)
      return "The accepted AppSpec digest is unavailable.";
    const preparations = toolResults.filter(
      ({ name }) => name === "prepare_target_dependencies",
    );
    const requiredResults = stale ? 3 : lostResponse ? 2 : 1;
    if (preparations.length < requiredResults)
      return {
        toolCalls: [
          {
            name: "prepare_target_dependencies",
            input: {
              expectedAppSpecDigest: stale
                ? "0".repeat(64)
                : status.appSpec.digest,
            },
          },
        ],
      };
    const preparation = preparations.at(-1);
    if (preparation === undefined)
      return "The dependency-preparation result is unavailable.";
    if (preparation.isError)
      return stale
        ? "Stale offline dependency preparation was rejected; the exact durable receipt was preserved."
        : "Offline dependency preparation was canceled or rejected; accepted AppSpec state was preserved.";
    const output = preparation.output as { reused?: boolean } | undefined;
    return output?.reused === true
      ? "The lost-response retry reused the exact durable dependency-preparation receipt after re-verifying the cache."
      : "The approved target-bound offline dependency closure was verified and materialized only in builder-owned planning metadata; request target planning separately.";
  }
  if (message.includes("run target identity and planning")) {
    const statusResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (
      statusResult === undefined ||
      ((statusResult.output as { phase?: string } | undefined)?.phase !==
        "dependencies_prepared" &&
        toolResults.at(-1)?.name !== "workspace_status")
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      { appSpec?: { digest?: string }; phase?: string } | undefined;
    if (
      status?.phase !== "dependencies_prepared" ||
      status.appSpec?.digest === undefined
    )
      return "Approved offline dependency preparation is required before target planning.";
    const latestResult = toolResults.at(-1);
    const planResult =
      latestResult?.name === "plan_app_creation" ? latestResult : undefined;
    if (planResult === undefined) {
      const existing = [...toolResults]
        .reverse()
        .find(({ name }) => name === "inspect_existing_app")?.output as
        { files?: readonly { path: string; content: string }[] } | undefined;
      const existingAppChanges = existing?.files?.flatMap(
        ({ path, content }) => {
          const changed = content.replace(
            /(return\s*\(\s*<(?:main|div|section)\b[^>]*>)/u,
            (opening) =>
              `${opening}\n<p data-vendor-review-status="tax-verification">Tax verification required</p>`,
          );
          return changed === content ? [] : [{ path, content: changed }];
        },
      );
      return {
        toolCalls: [
          {
            name: "plan_app_creation",
            input: {
              expectedAppSpecDigest: status.appSpec.digest,
              ...(existingAppChanges === undefined ||
              existingAppChanges.length === 0
                ? {}
                : { existingAppChanges }),
            },
          },
        ],
      };
    }
    return planResult.isError
      ? "Target identity and planning were canceled or rejected; no target mutation occurred."
      : "The Vendor review now shows when tax verification is required, and the update is ready for the private preview.";
  }
  if (
    message.includes("apply the current creation proposal") ||
    message.includes("retry target apply") ||
    message.includes("apply with a stale proposal digest")
  ) {
    const stale = message.includes("stale proposal digest");
    const lostResponse = message.includes("lost response");
    const applications = toolResults.filter(
      ({ name }) => name === "apply_app_creation",
    );
    const requiredResults = stale ? 3 : lostResponse ? 2 : 1;
    const statusResults = toolResults.filter(
      ({ name }) => name === "workspace_status",
    );
    const latestStatus = statusResults.at(-1);
    const latestApplyIndex = toolResults.findLastIndex(
      ({ name }) => name === "apply_app_creation",
    );
    const latestPlanIndex = toolResults.findLastIndex(
      ({ name }) => name === "plan_app_creation",
    );
    const latestStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "workspace_status",
    );
    if (
      latestStatus === undefined ||
      latestPlanIndex > latestStatusIndex ||
      (applications.length >= requiredResults &&
        latestApplyIndex > latestStatusIndex)
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = latestStatus.output as
      | {
          phase?: string;
          proposal?: { digest?: string };
          apply?: { status?: string };
        }
      | undefined;
    if (
      status?.phase !== "planned" &&
      status?.phase !== "apply_failed" &&
      status?.phase !== "applied"
    )
      return "I need a complete implementation plan before I can prepare the app.";
    if (applications.length < requiredResults) {
      const proposalDigest = status.proposal?.digest;
      if (proposalDigest === undefined)
        return "I couldn't safely prepare the app from the current plan.";
      return {
        toolCalls: [
          {
            name: "apply_app_creation",
            input: {
              expectedProposalDigest: stale ? "0".repeat(64) : proposalDigest,
            },
          },
        ],
      };
    }
    const result = applications.at(-1);
    if (result?.isError) {
      if (stale)
        return "The product plan changed, so I stopped before preparing the app.";
      if (status.phase === "apply_failed")
        return "I couldn't finish preparing the app safely. The current plan remains available to review.";
      return "I couldn't safely prepare the app. The current plan remains available to review.";
    }
    const output = result?.output as { reused?: boolean } | undefined;
    return output?.reused === true
      ? "The prepared app is unchanged and ready for quality checks."
      : "The app is assembled in a private preview and ready for quality checks.";
  }
  if (
    message.includes("record a replacement prototype artifact") ||
    message.includes("retry recording the exact replacement prototype artifact")
  ) {
    const content = "replacement artifact";
    const digest = sha256(content);
    const results = toolResults.filter(
      ({ name }) => name === "record_prototype_artifact",
    );
    const latest = results.at(-1);
    const matching = results.filter(
      (result) =>
        !result.isError &&
        (result.output as { digest?: string } | undefined)?.digest === digest,
    );
    const requiredMatches = message.includes("retry recording") ? 2 : 1;
    const failedRecordings = results.filter(({ isError }) => isError).length;
    if (
      latest?.isError &&
      (!message.includes("retry recording") || failedRecordings >= 2)
    )
      return "Prototype artifact recording was canceled; durable state was not changed.";
    if (matching.length >= requiredMatches) {
      const output = matching.at(-1)?.output as
        { invalidated?: boolean; reused?: boolean } | undefined;
      if (output?.reused === true)
        return "The retry reused the exact stored artifact revision without changing durable state.";
      return output?.invalidated === true
        ? "The new artifact revision invalidated the accepted AppSpec and proposal."
        : "The new artifact revision was recorded.";
    }
    return {
      toolCalls: [
        {
          name: "record_prototype_artifact",
          input: {
            path: "prototype/expense-review/app-spec.md",
            mediaType: "text/markdown",
            content,
          },
        },
      ],
    };
  }
  if (
    message.includes("validate the applied creation") ||
    message.includes("retry target validation") ||
    message.includes("validate with a stale apply digest")
  ) {
    const stale = message.includes("stale apply digest");
    const lostResponse = message.includes("lost response");
    const validations = toolResults.filter(
      ({ name }) => name === "validate_app_creation",
    );
    const requiredResults = stale ? 3 : lostResponse ? 2 : 1;
    const statusResults = toolResults.filter(
      ({ name }) => name === "workspace_status",
    );
    const latestStatus = statusResults.at(-1);
    const latestValidationIndex = toolResults.findLastIndex(
      ({ name }) => name === "validate_app_creation",
    );
    const latestStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "workspace_status",
    );
    if (
      latestStatus === undefined ||
      (validations.length >= requiredResults &&
        latestValidationIndex > latestStatusIndex)
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = latestStatus.output as
      | {
          phase?: string;
          apply?: { digest?: string };
        }
      | undefined;
    if (
      status?.phase !== "applied" &&
      status?.phase !== "validation_pending" &&
      status?.phase !== "validation_failed" &&
      status?.phase !== "validated"
    )
      return "The app must be prepared before I can run its quality checks.";
    if (validations.length < requiredResults) {
      const applyDigest = status.apply?.digest;
      if (applyDigest === undefined)
        return "I couldn't safely run checks against the current app.";
      return {
        toolCalls: [
          {
            name: "validate_app_creation",
            input: {
              expectedApplyDigest: stale ? "0".repeat(64) : applyDigest,
            },
          },
        ],
      };
    }
    const result = validations.at(-1);
    if (result?.isError) {
      if (stale)
        return "The app changed before checks could start, so I stopped safely.";
      if (status.phase === "validation_pending")
        return "The app checks did not finish, so the current preview still needs review.";
      if (status.phase === "validation_failed")
        return "The app did not pass its quality checks and needs another revision.";
      return "I couldn't safely finish the app checks. The current preview still needs review.";
    }
    const output = result?.output as { reused?: boolean } | undefined;
    return output?.reused === true
      ? "The app remains unchanged and its quality checks are still passing."
      : "The app passed its local quality checks and is ready for review.";
  }
  if (
    message.includes("inspect the validated change set") ||
    message.includes("accept the displayed change set") ||
    message.includes("retry change-set acceptance") ||
    message.includes("accept a stale change set")
  ) {
    const stale = message.includes("stale change set");
    const retry = message.includes("retry change-set acceptance");
    const accepted = toolResults.filter(
      ({ name }) => name === "accept_change_set",
    );
    const requiredAccepts = stale ? 3 : retry ? 2 : 1;
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    const latestStatus = status?.output as
      { phase?: string; validation?: { digest?: string } } | undefined;
    if (
      status === undefined ||
      (latestStatus?.phase !== "validated" &&
        latestStatus?.phase !== "reviewed")
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const proposal = [...toolResults]
      .reverse()
      .find(({ name }) => name === "change_set_status");
    if (proposal === undefined)
      return {
        toolCalls: [
          {
            name: "change_set_status",
            input: {
              expectedValidationDigest: latestStatus.validation?.digest,
            },
          },
        ],
      };
    if (message.includes("inspect the validated change set")) {
      if (proposal.isError)
        return "I couldn't prepare the completed app changes for review.";
      const output = proposal.output as
        | {
            digest?: string;
            changes?: readonly unknown[];
            approvedPaths?: readonly string[];
          }
        | undefined;
      return `The completed app changes are ready for review across ${String(output?.changes?.length ?? 0)} files.`;
    }
    if (accepted.length < requiredAccepts) {
      const output = proposal.output as
        | {
            digest?: string;
            approvedPaths?: readonly string[];
            changes?: readonly unknown[];
          }
        | undefined;
      return {
        toolCalls: [
          {
            name: "accept_change_set",
            input: {
              changeSet: {
                digest: stale ? "0".repeat(64) : output?.digest,
                approvedPaths: output?.approvedPaths,
                changes: output?.changes,
              },
            },
          },
        ],
      };
    }
    const result = accepted.at(-1);
    if (result?.isError)
      return stale
        ? "The app changed before review could finish, so I stopped safely."
        : "I couldn't safely prepare the completed app changes for review.";
    const output = result?.output as { reused?: boolean } | undefined;
    return output?.reused === true
      ? "The same completed app changes remain ready for review. If you want to continue, I can prepare a draft pull request for the repository."
      : "The completed app changes are ready for review. If you want to continue, I can prepare a draft pull request for the repository.";
  }
  if (
    message.includes("inspect fresh repository bootstrap at ") ||
    message.includes("publish fresh repository bootstrap at ")
  ) {
    const destinationPath = lastUserMessage?.match(
      /(?:inspect|publish) fresh repository bootstrap at (\/\S+)/iu,
    )?.[1];
    if (destinationPath === undefined)
      return "The fresh repository destination is missing.";
    const review = [...toolResults]
      .reverse()
      .find(({ name, isError }) => name === "accept_change_set" && !isError)
      ?.output as { digest?: string } | undefined;
    if (review?.digest === undefined)
      return "An exact accepted fresh-template change set is required.";
    const statusResults = toolResults.filter(
      ({ name }) => name === "fresh_bootstrap_status",
    );
    const status = statusResults.at(-1);
    if (
      status === undefined ||
      (message.includes("stale review") && statusResults.length < 2)
    )
      return {
        toolCalls: [
          {
            name: "fresh_bootstrap_status",
            input: {
              expectedReviewDigest: message.includes("stale review")
                ? "0".repeat(64)
                : review.digest,
              destinationPath,
              expectedPrestate: message.includes("exact-empty")
                ? "empty-directory"
                : "absent",
              repositoryIdentity: {
                initialBranch: "main",
                authorName: "Autograph App Builder",
                authorEmail: "app-builder@users.noreply.github.com",
                commitMessage: "Bootstrap repository",
                commitTimestamp: "2026-08-25T12:00:00-04:00",
              },
            },
          },
        ],
      };
    if (status.isError)
      return "Fresh repository bootstrap status was rejected without target mutation.";
    if (message.includes("inspect fresh repository bootstrap"))
      return `Fresh repository bootstrap proposal: ${JSON.stringify(status.output)}. Publication requires a separate approval.`;
    const publications = toolResults.filter(
      ({ name }) => name === "publish_fresh_repository",
    );
    if (publications.length === 0) {
      const publication = { ...(status.output as Record<string, unknown>) };
      delete publication.workflowPhase;
      delete publication.retryAllowed;
      delete publication.recoveryAllowed;
      delete publication.reused;
      return {
        toolCalls: [
          {
            name: "publish_fresh_repository",
            input: { publication },
          },
        ],
      };
    }
    const publication = publications.at(-1);
    if (publication?.isError)
      return "Fresh repository publication was canceled, stale, or recovery-required; no other publication tool was used.";
    return "The exact approved fresh-template result was atomically published as one parentless SHA-1 local repository with no remotes and release disabled.";
  }
  if (
    message.includes("recover fresh repository bootstrap") ||
    message.includes("retry fresh repository recovery after a lost response")
  ) {
    const latestRecoveryIndex = toolResults.findLastIndex(
      ({ name }) => name === "recover_fresh_repository",
    );
    const latestStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "artifact_workflow_status",
    );
    if (
      message.includes("lost response") &&
      latestRecoveryIndex > latestStatusIndex
    )
      return { toolCalls: [{ name: "artifact_workflow_status", input: {} }] };
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "artifact_workflow_status");
    if (status === undefined)
      return { toolCalls: [{ name: "artifact_workflow_status", input: {} }] };
    const workflow = status.output as
      | {
          phase?: string;
          freshBootstrap?: { digest?: string; proposalDigest?: string };
        }
      | undefined;
    if (
      workflow?.phase === "published_fresh_bootstrap" &&
      message.includes("lost response")
    )
      return "The lost-response recovery retry reused the exact durable fresh-bootstrap success receipt without redispatching recovery or another publication tool.";
    if (
      workflow?.phase !== "fresh_bootstrap_failed" ||
      workflow.freshBootstrap?.digest === undefined ||
      workflow.freshBootstrap.proposalDigest === undefined
    )
      return "An exact recovery-required fresh-bootstrap receipt is required.";
    const recoveries = toolResults.filter(
      ({ name }) => name === "recover_fresh_repository",
    );
    if (recoveries.length === 0)
      return {
        toolCalls: [
          {
            name: "recover_fresh_repository",
            input: {
              expectedJournalDigest: workflow.freshBootstrap.digest,
              expectedProposalDigest: workflow.freshBootstrap.proposalDigest,
            },
          },
        ],
      };
    const recovery = recoveries.at(-1);
    if (recovery?.isError)
      return "Fresh repository recovery was canceled or rejected; the exact recovery-required receipt remains authoritative.";
    return "The separately approved exact fresh-repository recovery completed without using another publication or mutation tool.";
  }
  if (
    message.includes("publish reviewed change set to a new branch worktree") ||
    message.includes(
      "publish reviewed change set with stale branch preconditions",
    ) ||
    message.includes(
      "retry branch worktree publication after a lost response",
    ) ||
    message.includes("recover branch worktree publication")
  ) {
    const stale = message.includes("stale branch preconditions");
    const recover = message.includes("recover branch worktree publication");
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "artifact_workflow_status");
    if (status === undefined)
      return { toolCalls: [{ name: "artifact_workflow_status", input: {} }] };
    const reviewDigest = (
      status.output as { review?: { digest?: string } } | undefined
    )?.review?.digest;
    if (reviewDigest === undefined)
      return "An exact reviewed receipt is required before branch-worktree publication.";
    const publicationStatuses = toolResults.filter(
      ({ name }) => name === "branch_worktree_publication_status",
    );
    const latestMutation = [...toolResults]
      .reverse()
      .find(
        ({ name }) =>
          name === "publish_reviewed_change_set_to_branch_worktree" ||
          name === "recover_branch_worktree_publication",
      );
    const latestMutationIndex = toolResults.findLastIndex(
      ({ name }) =>
        name === "publish_reviewed_change_set_to_branch_worktree" ||
        name === "recover_branch_worktree_publication",
    );
    const latestBranchStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "branch_worktree_publication_status",
    );
    const latestStatus = publicationStatuses.at(-1);
    if (
      latestStatus === undefined ||
      (latestMutation !== undefined &&
        latestBranchStatusIndex < latestMutationIndex)
    )
      return {
        toolCalls: [
          {
            name: "branch_worktree_publication_status",
            input: { expectedReviewDigest: reviewDigest },
          },
        ],
      };
    if (latestStatus.isError || latestStatus.output === undefined)
      return stale
        ? "Stale branch-worktree publication was rejected without creating a branch or worktree."
        : "Branch-worktree publication preconditions were rejected without mutating the source checkout.";
    const output = latestStatus.output as Record<string, unknown>;
    const proposal = { ...output };
    if (typeof proposal.proposalDigest === "string")
      proposal.digest = proposal.proposalDigest;
    for (const key of [
      "workflowPhase",
      "transactionWindow",
      "retryAllowed",
      "recoveryAllowed",
      "status",
      "proposalDigest",
      "publishedByCallId",
      "recoveryOfDigest",
      "branchCreated",
      "worktreeCreated",
      "appliedPaths",
      "recoveryRequired",
      "reason",
      "failureMessage",
      "worktreeRootIdentity",
      "worktreeGitDirectoryPath",
      "worktreeGitDirectoryIdentity",
      "worktreeHeadReference",
      "worktreeIndexFileDigest",
      "worktreeRemoteDigest",
      "worktreeStatusDigest",
      "postconditionDigest",
    ])
      delete proposal[key];
    if (recover) {
      if (output.status === "succeeded")
        return "The separately approved recovery completed the exact durable branch-worktree intent without a commit, push, remote publication, provider, deployment, or release action.";
      if (typeof output.digest !== "string")
        return "The exact durable recovery journal digest is unavailable.";
      if (toolResults.at(-1)?.name !== "recover_branch_worktree_publication")
        return {
          toolCalls: [
            {
              name: "recover_branch_worktree_publication",
              input: {
                publication: proposal,
                expectedJournalDigest: output.digest,
              },
            },
          ],
        };
      return latestMutation?.isError
        ? "Branch-worktree recovery was canceled or rejected; its exact durable receipt was preserved."
        : "The separately approved recovery completed the exact durable branch-worktree intent without a commit, push, remote publication, provider, deployment, or release action.";
    }
    if (output.status === "succeeded")
      return message.includes("retry branch worktree publication")
        ? "The exact durable branch-worktree publication receipt was verified and reused; no operation was redispatched."
        : "The separately approved reviewed change set was applied only in a new deterministic branch worktree. The original checkout was unchanged, and no commit, push, GitHub, provider, deployment, or release operation ran.";
    if (output.status === "pending" || output.status === "failed")
      return message.includes("retry branch worktree publication")
        ? "The durable branch-worktree publication attempt is recovery-required and was not redispatched automatically."
        : output.status === "failed"
          ? "Branch-worktree publication recorded a recovery-required partial-failure receipt and was not retried."
          : "The durable branch-worktree publication attempt is recovery-required and was not redispatched automatically.";
    if (
      latestMutation?.isError === true &&
      latestMutationIndex < latestBranchStatusIndex
    )
      return stale
        ? "Stale branch-worktree publication was rejected without creating a branch or worktree."
        : "Branch-worktree publication was canceled or rejected; the reviewed receipt was preserved.";
    if (latestMutationIndex < latestBranchStatusIndex)
      return {
        toolCalls: [
          {
            name: "publish_reviewed_change_set_to_branch_worktree",
            input: {
              publication: stale
                ? { ...proposal, sourceStatusDigest: "0".repeat(64) }
                : proposal,
            },
          },
        ],
      };
    if (latestMutation?.isError)
      return stale
        ? "Stale branch-worktree publication was rejected without creating a branch or worktree."
        : "Branch-worktree publication was canceled or rejected; the reviewed receipt was preserved.";
    const result = latestMutation?.output as { status?: string } | undefined;
    return result?.status === "failed"
      ? "Branch-worktree publication recorded a recovery-required partial-failure receipt and was not retried."
      : "The separately approved reviewed change set was applied only in a new deterministic branch worktree. The original checkout was unchanged, and no commit, push, GitHub, provider, deployment, or release operation ran.";
  }
  if (
    message.includes("publish reviewed change set locally") ||
    message.includes("retry local publication") ||
    message.includes("publish reviewed change set with stale")
  ) {
    const stale = message.includes("stale");
    const retry = message.includes("retry");
    const afterCancellation = message.includes("after cancellation");
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    const workflow = status?.output as
      { phase?: string; review?: { digest?: string } } | undefined;
    const latestPublicationIndex = toolResults.findLastIndex(
      ({ name }) => name === "publish_reviewed_change_set",
    );
    const latestStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "workspace_status",
    );
    if (
      status === undefined ||
      (retry && latestPublicationIndex > latestStatusIndex) ||
      workflow === undefined ||
      ![
        "reviewed",
        "publication_pending",
        "publication_failed",
        "published_local",
      ].includes(workflow?.phase ?? "")
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const source = [...toolResults]
      .reverse()
      .find(({ name }) => name === "inspect_source");
    const destinationPath = (
      source?.output as { sourcePath?: string } | undefined
    )?.sourcePath;
    if (destinationPath === undefined || workflow.review?.digest === undefined)
      return "An exact reviewed receipt and explicitly inspected local checkout are required before local publication.";
    const reviewDigest = workflow.review.digest;
    const publicationResults = toolResults.filter(
      ({ name }) => name === "publish_reviewed_change_set",
    );
    const required = stale ? 4 : retry ? 3 : afterCancellation ? 2 : 1;
    const publicationStatuses = toolResults.filter(
      ({ name }) => name === "local_publication_status",
    );
    const latestPublicationStatusIndex = toolResults.findLastIndex(
      ({ name }) => name === "local_publication_status",
    );
    if (
      latestPublicationStatusIndex < latestStatusIndex ||
      latestPublicationStatusIndex < latestPublicationIndex
    )
      return {
        toolCalls: [
          {
            name: "local_publication_status",
            input: {
              destinationPath,
              expectedReviewDigest: reviewDigest,
            },
          },
        ],
      };
    if (
      message.includes("dirty overlap") &&
      toolResults.at(-1)?.name !== "local_publication_status"
    )
      return {
        toolCalls: [
          {
            name: "local_publication_status",
            input: {
              destinationPath,
              expectedReviewDigest: reviewDigest,
            },
          },
        ],
      };
    const proposal = [...publicationStatuses].reverse().at(0);
    if (proposal === undefined)
      return {
        toolCalls: [
          {
            name: "local_publication_status",
            input: {
              destinationPath,
              expectedReviewDigest: reviewDigest,
            },
          },
        ],
      };
    if (proposal.isError || proposal.output === undefined) {
      if (message.includes("dirty overlap"))
        return "Local publication preconditions were rejected before approval or destination mutation.";
      return {
        toolCalls: [
          {
            name: "local_publication_status",
            input: {
              destinationPath,
              expectedReviewDigest: reviewDigest,
            },
          },
        ],
      };
    }
    const publicationState = proposal.output as {
      status?: string;
      retryAllowed?: boolean;
      recoveryAllowed?: boolean;
      transactionWindow?: string;
      workflowPhase?: string;
    };
    const durableStatus = publicationState.status;
    const latestPublicationOutput = publicationResults.at(-1)?.output as
      { reused?: boolean; terminalizedFailure?: boolean } | undefined;
    if (
      publicationState.workflowPhase === "published_local" &&
      retry &&
      latestPublicationOutput?.reused === true
    )
      return "The lost-response retry reused the exact durable local-publication receipt after postimage readback.";
    if (
      publicationState.workflowPhase === "published_local" &&
      !retry &&
      !stale
    )
      return "The separately approved reviewed change set was applied only to the named existing local checkout. No commit, branch, GitHub publication, provider, deployment, or release action ran.";
    if (
      publicationState.workflowPhase === "publication_failed" &&
      latestPublicationOutput?.terminalizedFailure === true
    )
      return "The exact durable local-publication failure was terminalized without redispatching destination mutation.";
    if (publicationState.workflowPhase === "publication_failed")
      return "The failed local-publication receipt is readable and was not redispatched automatically.";
    if (publicationState.recoveryAllowed === true && !retry)
      return "The durable terminal local-publication journal awaits an explicit recovery request and was not redispatched automatically.";
    if (
      durableStatus === "pending" ||
      publicationState.transactionWindow === "before-journal" ||
      (durableStatus === "failed" && !publicationState.recoveryAllowed)
    )
      return "The prior local-publication attempt is recovery-required and was not redispatched automatically.";
    const publicationProposal = {
      ...(proposal.output as Record<string, unknown>),
    };
    if (typeof publicationProposal.proposalDigest === "string")
      publicationProposal.digest = publicationProposal.proposalDigest;
    delete publicationProposal.workflowPhase;
    delete publicationProposal.recoveryAllowed;
    delete publicationProposal.retryAllowed;
    delete publicationProposal.transactionWindow;
    delete publicationProposal.durableJournal;
    delete publicationProposal.status;
    delete publicationProposal.publishedByCallId;
    delete publicationProposal.beforeStatusDigest;
    delete publicationProposal.afterStatusDigest;
    delete publicationProposal.appliedPaths;
    delete publicationProposal.intentPaths;
    delete publicationProposal.rolledBackPaths;
    delete publicationProposal.conflictedPaths;
    delete publicationProposal.uncertainPaths;
    delete publicationProposal.pathEvidence;
    delete publicationProposal.recoveryRequired;
    delete publicationProposal.reason;
    delete publicationProposal.failureMessage;
    delete publicationProposal.proposalDigest;
    delete publicationProposal.postconditionDigest;
    const recoveryResult = toolResults
      .slice(latestPublicationStatusIndex + 1)
      .find(({ name }) => name === "publish_reviewed_change_set");
    if (
      publicationState.recoveryAllowed === true &&
      recoveryResult === undefined
    )
      return {
        toolCalls: [
          {
            name: "publish_reviewed_change_set",
            input: { publication: publicationProposal },
          },
        ],
      };
    if (
      publicationState.recoveryAllowed !== true &&
      publicationResults.length < required
    )
      return {
        toolCalls: [
          {
            name: "publish_reviewed_change_set",
            input: {
              publication: stale
                ? {
                    ...publicationProposal,
                    reviewDigest: "0".repeat(64),
                  }
                : publicationProposal,
            },
          },
        ],
      };
    const result = recoveryResult ?? publicationResults.at(-1);
    if (result?.isError)
      return stale
        ? "Stale local publication was rejected without changing the destination checkout."
        : "Local publication was canceled or rejected; the reviewed receipt was preserved.";
    const output = result?.output as
      { reused?: boolean; terminalizedFailure?: boolean } | undefined;
    return output?.terminalizedFailure === true
      ? "The exact durable local-publication failure was terminalized without redispatching destination mutation."
      : output?.reused === true
        ? "The lost-response retry reused the exact durable local-publication receipt after postimage readback."
        : "The separately approved reviewed change set was applied only to the named existing local checkout. No commit, branch, GitHub publication, provider, deployment, or release action ran.";
  }
  if (message.includes("read recorded prototype artifact")) {
    const stale = message.includes("stale digest");
    const recorded = [...toolResults]
      .reverse()
      .find(
        ({ name, isError }) => name === "record_prototype_artifact" && !isError,
      );
    if (recorded === undefined && !stale)
      return "Record a prototype artifact before reading it.";
    const artifact = recorded?.output as
      { path?: string; digest?: string } | undefined;
    const read = [...toolResults]
      .reverse()
      .find(({ name }) => name === "get_prototype_artifact");
    if (read !== undefined && !(stale && !read.isError)) {
      if (read.isError)
        return "The prototype artifact digest was rejected as stale.";
      const output = read.output as
        { path?: string; digest?: string; content?: string } | undefined;
      return output?.path === artifact?.path &&
        output?.digest === artifact?.digest &&
        typeof output?.content === "string"
        ? "The exact content-addressed prototype artifact was read without a target command."
        : "The prototype artifact readback did not match its recorded receipt.";
    }
    return {
      toolCalls: [
        {
          name: "get_prototype_artifact",
          input: {
            path: stale
              ? "prototype/expense-review/app-spec.md"
              : artifact?.path,
            digest: stale ? "0".repeat(64) : artifact?.digest,
          },
        },
      ],
    };
  }
  if (message.includes("assess workspace readiness before planning")) {
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (
      status === undefined ||
      (status.output as { phase?: string }).phase === "empty"
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const readiness = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_readiness_status");
    if (readiness === undefined)
      return { toolCalls: [{ name: "workspace_readiness_status", input: {} }] };
    return "The workspace readiness receipt is not ready for target execution, and no target command was run.";
  }
  if (message.includes("assess target command readiness")) {
    const statusResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (statusResult === undefined)
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      { phase?: string; proposal?: { digest?: string } } | undefined;
    if (
      status?.phase !== "planned" &&
      status?.phase !== "apply_failed" &&
      status?.phase !== "applied" &&
      status?.phase !== "validation_pending" &&
      status?.phase !== "validation_failed" &&
      status?.phase !== "validated"
    )
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const readinessResult = [...toolResults]
      .reverse()
      .find(({ name }) => name === "target_execution_status");
    const staleRequest = message.includes("stale proposal digest");
    if (
      readinessResult === undefined ||
      (staleRequest && !readinessResult.isError)
    ) {
      const digest = staleRequest ? "0".repeat(64) : status?.proposal?.digest;
      if (digest === undefined)
        return "A canonical proposal is required before target command readiness can be checked.";
      return {
        toolCalls: [
          {
            name: "target_execution_status",
            input: { expectedProposalDigest: digest },
          },
        ],
      };
    }
    if (readinessResult.isError)
      return "The target command readiness receipt rejected the stale proposal.";
    const readiness = readinessResult.output as
      { targetCommandReady?: boolean } | undefined;
    return readiness?.targetCommandReady === true
      ? "The exact proposal is ready for a future typed target command."
      : "The exact proposal is not ready for a target command, and no target command was run.";
  }
  if (message.includes("inspect the sandbox toolchain")) {
    const result = toolResults.find(
      ({ name }) => name === "inspect_sandbox_toolchain",
    );
    if (result === undefined)
      return {
        toolCalls: [{ name: "inspect_sandbox_toolchain", input: {} }],
      };
    return result.isError
      ? "Sandbox toolchain inspection failed."
      : `Sandbox toolchain receipt: ${JSON.stringify(result.output)}`;
  }
  if (message.includes("attempt appspec mutation after publication")) {
    const status = [...toolResults]
      .reverse()
      .find(({ name }) => name === "workspace_status");
    if (status === undefined)
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const workflow = status.output as
      | {
          phase?: string;
          workspace?: {
            sourceSha?: string;
            sourceTree?: string;
            eligibilityDigest?: string;
            workspaceDigest?: string;
          };
          appSpec?: {
            appId?: string;
            digest?: string;
            artifactRevision?: string;
          };
        }
      | undefined;
    const attempts = toolResults.filter(
      ({ name }) => name === "accept_app_spec",
    );
    if (attempts.length < 2)
      return {
        toolCalls: [
          {
            name: "accept_app_spec",
            input: {
              appId: workflow?.appSpec?.appId,
              expectedArtifactDigest: workflow?.appSpec?.digest,
              expectedArtifactRevision: workflow?.appSpec?.artifactRevision,
              expectedSourceSha: workflow?.workspace?.sourceSha,
              expectedSourceTree: workflow?.workspace?.sourceTree,
              expectedEligibilityDigest: workflow?.workspace?.eligibilityDigest,
              expectedWorkspaceDigest: workflow?.workspace?.workspaceDigest,
            },
          },
        ],
      };
    return attempts.at(-1)?.isError
      ? "AppSpec mutation was denied by the terminal publication workflow."
      : "AppSpec mutation unexpectedly succeeded.";
  }
  const appSpecMatch =
    /^accept build-ready appspec for ([a-z0-9-]+):\n([\s\S]+)$/iu.exec(
      lastUserMessage ?? "",
    );
  if (appSpecMatch !== null) {
    const [, appId, appSpec] = appSpecMatch;
    if (appId === undefined || appSpec === undefined)
      return "The AppSpec request is malformed.";
    const statusResult = toolResults.find(
      ({ name }) => name === "workspace_status",
    );
    if (statusResult === undefined)
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    const status = statusResult.output as
      | {
          workspace?: {
            sourceSha?: string;
            sourceTree?: string;
            eligibilityDigest?: string;
            workspaceDigest?: string;
          };
        }
      | undefined;
    const workspace = status?.workspace;
    const acceptanceResult = toolResults.find(
      ({ name }) => name === "accept_app_spec",
    );
    if (acceptanceResult === undefined) {
      const artifactResult = [...toolResults]
        .reverse()
        .find(({ name }) => name === "record_prototype_artifact");
      if (artifactResult === undefined)
        return {
          toolCalls: [
            {
              name: "record_prototype_artifact",
              input: {
                path: `prototype/${appId}/app-spec.md`,
                mediaType: "text/markdown",
                content: appSpec,
              },
            },
          ],
        };
      const artifact = artifactResult.output as
        { digest?: string; revision?: string } | undefined;
      if (
        workspace?.sourceSha === undefined ||
        workspace.sourceTree === undefined ||
        workspace.eligibilityDigest === undefined ||
        workspace.workspaceDigest === undefined ||
        artifact?.digest === undefined ||
        artifact.revision === undefined
      )
        return "A verified prepared workspace is required before AppSpec acceptance.";
      return {
        toolCalls: [
          {
            name: "accept_app_spec",
            input: {
              appId,
              expectedArtifactDigest: artifact.digest,
              expectedArtifactRevision: artifact.revision,
              expectedSourceSha: workspace.sourceSha,
              expectedSourceTree: workspace.sourceTree,
              expectedEligibilityDigest: workspace.eligibilityDigest,
              expectedWorkspaceDigest: workspace.workspaceDigest,
            },
          },
        ],
      };
    }
    if (acceptanceResult.isError)
      return "The AppSpec acceptance could not be recorded.";
    return "The product direction is complete and ready for automatic implementation planning.";
  }
  if (
    message.includes("prepare supported repository at ") ||
    message.includes("prepare fresh template at ")
  ) {
    const path = lastUserMessage?.match(
      /prepare (?:supported repository|fresh template) at (\/\S+)/iu,
    )?.[1];
    if (path === undefined) return "The configured test repository is missing.";
    const sourceKind = message.includes("prepare fresh template at ")
      ? "fresh-template"
      : "existing-repository";
    const inspectionResult = toolResults.find(
      ({ name }) => name === "inspect_source",
    );
    if (inspectionResult === undefined) {
      return {
        toolCalls: [{ name: "inspect_source", input: { path, sourceKind } }],
      };
    }
    const inspected = inspectionResult.output as
      | {
          digest?: string;
        }
      | undefined;
    if (inspectionResult.isError) {
      return "The configured repository could not be inspected.";
    }
    const acquisitionResult = toolResults.find(
      ({ name }) => name === "approve_source_acquisition",
    );
    if (sourceKind === "fresh-template" && acquisitionResult === undefined) {
      if (inspected?.digest === undefined)
        return "The configured source receipt is incomplete.";
      return {
        toolCalls: [
          {
            name: "approve_source_acquisition",
            input: { expectedSourceReceiptDigest: inspected.digest },
          },
        ],
      };
    }
    if (acquisitionResult?.isError) {
      const sourceStatus = toolResults.find(
        ({ name }) => name === "source_status",
      );
      if (sourceStatus === undefined)
        return { toolCalls: [{ name: "source_status", input: {} }] };
      return "Fresh-template acquisition was canceled or became stale; no workspace was materialized.";
    }
    const preparationResult = toolResults.find(
      ({ name }) => name === "prepare_workspace",
    );
    if (preparationResult === undefined) {
      if (inspected?.digest === undefined) {
        return "The configured repository is not eligible.";
      }
      return {
        toolCalls: [
          {
            name: "prepare_workspace",
            input: {
              expectedSourceReceiptDigest: inspected.digest,
            },
          },
        ],
      };
    }
    const statusResult = toolResults.find(
      ({ name }) => name === "workspace_status",
    );
    if (statusResult === undefined) {
      return { toolCalls: [{ name: "workspace_status", input: {} }] };
    }
    if (statusResult.isError) {
      return "The workspace status could not be verified.";
    }
    const status = statusResult.output as { phase?: string } | undefined;
    if (preparationResult.isError) {
      return status?.phase === "empty"
        ? "Preparation was canceled, and the workspace phase remains empty."
        : "Preparation was canceled, but the workspace phase could not be confirmed empty.";
    }
    return status?.phase === "prepared"
      ? "The reviewed repository was prepared inside the App Builder workspace, and workspace status confirms the prepared phase."
      : "The repository preparation completed, but workspace status did not confirm the prepared phase.";
  }
  if (message.includes("capabilities")) {
    return "I can turn a product brief into a usable visual prototype and a reviewable implementation plan. I infer sensible names, routes, roles, and workflow defaults, explain the choices that shape the experience, and ask only when an answer would materially change the product. Before I change application code or publish, deploy, release, or alter a connected service, I will ask for approval in plain language. If an outcome is unavailable, I will explain the product limitation and recommend the closest useful alternative.";
  }
  return "Tell me what you want the app to help someone accomplish. I will infer a sensible starting experience and show you something reviewable.";
});

export default defineAgent({
  model: hasTestCapability("mock-model") ? testModel : "openai/gpt-5.6-sol",
  modelContextWindowTokens: 128_000,
  reasoning: "high",
  limits: {
    maxInputTokensPerSession: 2_000_000,
    maxOutputTokensPerSession: 200_000,
    sessionTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  },
});
