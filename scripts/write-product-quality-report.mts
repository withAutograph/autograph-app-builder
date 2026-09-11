import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  vendorOnboardingAppSpec,
  vendorOnboardingCompleteAppSpec,
  vendorOnboardingDecisions,
  vendorOnboardingPrototype,
} from "../agent/agent";
import {
  evaluatePrototypeQuality,
  productQualityScenario,
  PRODUCT_QUALITY_SCENARIOS,
} from "../evals/support/product-quality";
import { ARRUSTED_COMPONENT_COMPOSITION_MANIFEST } from "../evals/support/supported-repository";
import { validateBuildReadyAppSpec } from "../lib/agent/app-spec-validation";
import {
  auditAppliedAppComposition,
  bindArrustedComponentCompositionPolicy,
} from "../lib/agent/component-composition-policy";

const reportRoot = resolve(
  process.env.APP_BUILDER_PRODUCT_EVAL_REPORT_DIR ??
    ".artifacts/product-quality"
);
const vendorEvidenceRoot = resolve(reportRoot, "vendor-onboarding");
const vendor = productQualityScenario("vendor-onboarding");
const prototype = evaluatePrototypeQuality({
  appSpec: vendorOnboardingCompleteAppSpec,
  html: vendorOnboardingPrototype,
  scenario: vendor,
});
const policy = bindArrustedComponentCompositionPolicy({
  content: ARRUSTED_COMPONENT_COMPOSITION_MANIFEST,
  sourceSha: "a".repeat(40),
  sourceTree: "b".repeat(40),
});
if (policy.status === "unavailable") {
  throw new Error(
    `Fixture composition policy unavailable: ${policy.reasons.join(" ")}`
  );
}
const composition = auditAppliedAppComposition({
  appId: vendor.expected.prototype?.appId ?? "vendor-onboarding",
  binding: policy.binding,
  files: [
    {
      content:
        'import { Button, KpiCard, PageHeader } from "@autograph/components";\nimport { Check } from "@autograph/icons";\nimport "@autograph/design-system/tokens.css";\n\nexport default function Page() {\n  return <><PageHeader title="Vendor Review" /><KpiCard icon={Check} title="Ready" value={3} /><Button>Start Guided Review</Button></>;\n}\n',
      path: "apps/vendor-onboarding/app/page.tsx",
    },
  ],
});
const report = {
  evidence: {
    appSpecPath: "prototype/vendor-onboarding/app-spec.md",
    policy: {
      digest: policy.binding.policyDigest,
      fixtureSourceSha: policy.binding.sourceSha,
      fixtureSourceTree: policy.binding.sourceTree,
      note: "The Eve integration gate binds these fields to the selected Arrusted source before auditing an applied app.",
      path: "docs/component-composition.json",
    },
    prototypePath: "prototype/vendor-onboarding/index.html",
    visual: {
      note: "Recorded fixture interaction evidence only; use eval:design for generated UI quality.",
      status: "reported by the Playwright product-quality visual test",
    },
  },
  hardGates: {
    appSpec: validateBuildReadyAppSpec(vendorOnboardingCompleteAppSpec).valid
      ? "passed"
      : "failed",
    componentComposition: composition.status,
    eve: "validated by evals/product-quality.eval.ts",
    prototype: prototype.hardFailures.length === 0 ? "passed" : "failed",
  },
  quality: {
    conversation:
      "reported per scenario by the Eve suite; quality scores do not gate CI",
    prototype: prototype.score,
  },
  scenarios: PRODUCT_QUALITY_SCENARIOS.map((scenario) => ({
    id: scenario.id,
    conversation: "validated by the Eve product-quality scenario",
    requiredReplyOutcomes: scenario.expected.replyIncludes,
  })),
  source: {
    vendorOnboardingAppSpecBytes: Buffer.byteLength(vendorOnboardingAppSpec),
  },
  suite: "app-builder-product-quality",
  version: 1,
};

await mkdir(reportRoot, { recursive: true });
await mkdir(vendorEvidenceRoot, { recursive: true });
await writeFile(
  resolve(vendorEvidenceRoot, "index.html"),
  vendorOnboardingPrototype
);
await writeFile(
  resolve(vendorEvidenceRoot, "decisions.md"),
  vendorOnboardingDecisions
);
await writeFile(
  resolve(vendorEvidenceRoot, "app-spec.md"),
  vendorOnboardingCompleteAppSpec
);
await writeFile(
  resolve(vendorEvidenceRoot, "component-policy.json"),
  `${JSON.stringify(
    {
      fixtureSourceSha: policy.binding.sourceSha,
      fixtureSourceTree: policy.binding.sourceTree,
      policyDigest: policy.binding.policyDigest,
      policyPath: "docs/component-composition.json",
      requiredPublicImports: policy.binding.policy.publicImports,
      status: composition.status,
      tokenEntrypoints: policy.binding.policy.tokenEntrypoints,
    },
    null,
    2
  )}\n`
);
await writeFile(
  resolve(reportRoot, "product-quality-report.json"),
  `${JSON.stringify(report, null, 2)}\n`
);
const summary = [
  "## App Builder product-quality evals",
  "",
  `- Hard prototype gate: **${report.hardGates.prototype}**`,
  `- Hard AppSpec gate: **${report.hardGates.appSpec}**`,
  `- Hard Arrusted composition gate: **${report.hardGates.componentComposition}**`,
  `- Quality report: \`product-quality-report.json\``,
].join("\n");
if (process.env.GITHUB_STEP_SUMMARY === undefined) {
  process.stdout.write(`${summary}\n`);
} else {
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
}
