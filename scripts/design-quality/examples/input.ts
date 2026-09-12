import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { UiPreviewInput } from "../../../lib/agent/ui-preview";
import { validateUiPreview } from "../../../lib/agent/ui-preview";

export type DesignQualityExampleId = "spend-import-review" | "compensation-planning";

interface ExampleConfig {
  appId: string;
  route: string;
  entry: string;
  source: string;
  stateSource: string;
  stateTarget: string;
}

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning tool or script contract
async function text(root: string, path: string) {
  return readFile(resolve(root, path), "utf-8");
}

const exampleManifests: Record<
  DesignQualityExampleId,
  Pick<
    UiPreviewInput["manifest"],
    | "productionComponents"
    | "productionCompositions"
    | "fixtureFacts"
    | "decisions"
    | "assumptions"
    | "openQuestions"
    | "implementationNotes"
  >
> = {
  "spend-import-review": {
    productionComponents: [
      "Button",
      "Card",
      "DecisionOptionCard",
      "Disclosure",
      "FieldFrame",
      "PageHeader",
      "Select",
      "StatusPill",
      "Typography",
    ].map((name) => ({ name, source: "@autograph/components" as const })),
    productionCompositions: [
      { name: "DataTableComposition", source: "@autograph/compositions" },
      { name: "RecordDetailPanel", source: "@autograph/compositions" },
    ],
    fixtureFacts: [
      {
        id: "synthetic-batch",
        statement:
          "The AP export has 42 synthetic rows: 38 initially ready and 4 requiring human review.",
        routes: ["/"],
      },
    ],
    decisions: [
      {
        id: "mapping-first",
        statement:
          "A reviewer sees derived preview rows and counts from the current mapping before the simulated save.",
        routes: ["/"],
      },
    ],
    assumptions: [
      {
        id: "in-memory-effects",
        statement:
          "Mapping, save, and exception resolution effects exist only in the preview session.",
        routes: ["/"],
      },
    ],
    openQuestions: [],
    implementationNotes: [
      {
        visibleElement: "Derived import preview and save outcome",
        productionMeaning:
          "Production must derive imported records and review counts from the accepted mapping while preserving source evidence.",
        routes: ["/"],
      },
    ],
  },
  "compensation-planning": {
    productionComponents: ["Button", "Card", "PageHeader", "StatusPill", "Typography"].map(
      (name) => ({ name, source: "@autograph/components" as const }),
    ),
    productionCompositions: [{ name: "SchemaFormComposition", source: "@autograph/compositions" }],
    fixtureFacts: [
      {
        id: "synthetic-proposal",
        statement:
          "Taylor Nguyen has a synthetic L5 draft with editable cost and policy assumptions.",
        routes: ["/"],
      },
    ],
    decisions: [
      {
        id: "review-after-edit",
        statement:
          "A planning decision can be recorded only after valid edited assumptions are applied.",
        routes: ["/"],
      },
    ],
    assumptions: [
      {
        id: "calculation-basis",
        statement:
          "The proposed increase and employer tax rate apply to base salary; bonus and benefits remain fixed.",
        routes: ["/"],
      },
    ],
    openQuestions: [
      {
        id: "band-policy",
        statement:
          "The fixture does not define whether an amount above midpoint needs an additional approval.",
        routes: ["/"],
      },
    ],
    implementationNotes: [
      {
        visibleElement: "Editable assumptions and calculated package comparison",
        productionMeaning:
          "Production must calculate authoritative current and proposed totals from governed compensation inputs.",
        routes: ["/"],
      },
    ],
  },
};

/** Assemble a checked-in case into the exact input accepted by renderUiPreview. */
export async function loadDesignQualityExample(
  id: DesignQualityExampleId,
  repositoryRoot = process.cwd(),
): Promise<UiPreviewInput> {
  const caseRoot = `docs/design-quality-cases/${id}`;
  const config = JSON.parse(
    await text(repositoryRoot, `${caseRoot}/example.json`),
  ) as ExampleConfig;
  const [source, stateSource, fixtureSource] = await Promise.all([
    text(repositoryRoot, config.source),
    text(repositoryRoot, config.stateSource),
    text(repositoryRoot, `${caseRoot}/fixtures.json`),
  ]);
  const input: UiPreviewInput = {
    appId: config.appId,
    routes: [config.route],
    files: [
      { path: config.entry, content: source },
      { path: config.stateTarget, content: stateSource },
      {
        path: "src/fixture.ts",
        content: `import type { ${id === "spend-import-review" ? "SpendFixture" : "CompensationFixture"} as Fixture } from ${JSON.stringify(`./${config.stateTarget.split("/").at(-1)?.replace(/\.ts$/u, "")}`)};\nconst fixture: Fixture = ${fixtureSource.trim()};\nexport default fixture;\n`,
      },
    ],
    catalogGaps: [],
    manifest: {
      version: 1,
      screens: [
        {
          id,
          title:
            id === "spend-import-review" ? "Spend import review" : "Compensation planning review",
          route: config.route,
          entry: config.entry,
        },
      ],
      productionIcons: [],
      ...exampleManifests[id],
    },
  };
  validateUiPreview(input);
  return input;
}
