import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import type { UiPreviewInput } from "../../../lib/agent/ui-preview";
import { validateUiPreview } from "../../../lib/agent/ui-preview";

export type DesignQualityExampleId = "spend-import-review" | "compensation-planning";

const compositionSource = "@autograph/compositions";

const exampleConfigSchema = z.object({
  appId: z.string(),
  entry: z.string(),
  route: z.string(),
  source: z.string(),
  stateSource: z.string(),
  stateTarget: z.string(),
});

const text = async (root: string, relativePath: string) =>
  await readFile(path.resolve(root, relativePath), "utf-8");

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
  "compensation-planning": {
    assumptions: [
      {
        id: "calculation-basis",
        routes: ["/"],
        statement:
          "The proposed increase and employer tax rate apply to base salary; bonus and benefits remain fixed.",
      },
    ],
    decisions: [
      {
        id: "review-after-edit",
        routes: ["/"],
        statement:
          "A planning decision can be recorded only after valid edited assumptions are applied.",
      },
    ],
    fixtureFacts: [
      {
        id: "synthetic-proposal",
        routes: ["/"],
        statement:
          "Taylor Nguyen has a synthetic L5 draft with editable cost and policy assumptions.",
      },
    ],
    implementationNotes: [
      {
        productionMeaning:
          "Production must calculate authoritative current and proposed totals from governed compensation inputs.",
        routes: ["/"],
        visibleElement: "Editable assumptions and calculated package comparison",
      },
    ],
    openQuestions: [
      {
        id: "band-policy",
        routes: ["/"],
        statement:
          "The fixture does not define whether an amount above midpoint needs an additional approval.",
      },
    ],
    productionComponents: ["Button", "Card", "PageHeader", "StatusPill", "Typography"].map(
      (name) => ({ name, source: "@autograph/components" as const }),
    ),
    productionCompositions: [{ name: "SchemaFormComposition", source: compositionSource }],
  },
  "spend-import-review": {
    assumptions: [
      {
        id: "in-memory-effects",
        routes: ["/"],
        statement:
          "Mapping, save, and exception resolution effects exist only in the preview session.",
      },
    ],
    decisions: [
      {
        id: "mapping-first",
        routes: ["/"],
        statement:
          "A reviewer sees derived preview rows and counts from the current mapping before the simulated save.",
      },
    ],
    fixtureFacts: [
      {
        id: "synthetic-batch",
        routes: ["/"],
        statement:
          "The AP export has 42 synthetic rows: 38 initially ready and 4 requiring human review.",
      },
    ],
    implementationNotes: [
      {
        productionMeaning:
          "Production must derive imported records and review counts from the accepted mapping while preserving source evidence.",
        routes: ["/"],
        visibleElement: "Derived import preview and save outcome",
      },
    ],
    openQuestions: [],
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
      { name: "DataTableComposition", source: compositionSource },
      { name: "RecordDetailPanel", source: compositionSource },
    ],
  },
};

/** Assemble a checked-in case into the exact input accepted by renderUiPreview. */
export async function loadDesignQualityExample(
  id: DesignQualityExampleId,
  repositoryRoot = process.cwd(),
): Promise<UiPreviewInput> {
  const caseRoot = `docs/design-quality-cases/${id}`;
  const config = exampleConfigSchema.parse(
    JSON.parse(await text(repositoryRoot, `${caseRoot}/example.json`)),
  );
  const [source, stateSource, fixtureSource] = await Promise.all([
    text(repositoryRoot, config.source),
    text(repositoryRoot, config.stateSource),
    text(repositoryRoot, `${caseRoot}/fixtures.json`),
  ]);
  const stateModule = config.stateTarget.split("/").at(-1)?.replace(/\.ts$/u, "");
  const fixtureType = id === "spend-import-review" ? "SpendFixture" : "CompensationFixture";
  const fixtureModule = `./${stateModule}`;
  const fixtureImport = JSON.stringify(fixtureModule);
  const input: UiPreviewInput = {
    appId: config.appId,
    catalogGaps: [],
    files: [
      { content: source, path: config.entry },
      { content: stateSource, path: config.stateTarget },
      {
        content: `import type { ${fixtureType} as Fixture } from ${fixtureImport};\nconst fixture: Fixture = ${fixtureSource.trim()};\nexport default fixture;\n`,
        path: "src/fixture.ts",
      },
    ],
    manifest: {
      productionIcons: [],
      screens: [
        {
          entry: config.entry,
          id,
          route: config.route,
          title:
            id === "spend-import-review" ? "Spend import review" : "Compensation planning review",
        },
      ],
      version: 1,
      ...exampleManifests[id],
    },
    routes: [config.route],
  };
  validateUiPreview(input);
  return input;
}
