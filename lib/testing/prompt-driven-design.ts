import type { UiPreviewInput } from "../agent/ui-preview";

export const renewalReviewDesignPrompt =
  "Create a component-backed renewal review UI for customer-success managers deciding which upcoming renewals need intervention. The workflow is not settled yet.";

export const renewalReviewUiPreview = {
  appId: "renewal-review",
  routes: ["/"],
  files: [
    {
      path: "src/routes/index.tsx",
      content: `import { useState } from "react";
import { Button, PageHeader, PageTabs, StatusPill } from "@autograph/components";
import { DataTableComposition } from "@autograph/compositions";
const renewals = [
  { account: "Northstar Health", owner: "Maya Chen", renewal: "Sep 23", value: "$184,000", health: "At risk", action: "Executive alignment" },
  { account: "Kiteworks GmbH", owner: "Jon Bell", renewal: "Oct 08", value: "$96,000", health: "Watch", action: "Confirm adoption plan" },
  { account: "Mercury Labs", owner: "Ari Jones", renewal: "Oct 21", value: "$72,000", health: "Healthy", action: "Prepare renewal" },
];
export default function RenewalReview() {
  const [filter, setFilter] = useState("Needs intervention");
  const visible = filter === "All renewals" ? renewals : renewals.filter((item) => item.health !== "Healthy");
  return <main>
    <PageTabs items={[{ id: "renewals", label: "Renewals" }, { id: "portfolio", label: "Portfolio" }]} value="renewals" onValueChange={() => {}} />
    <PageHeader title="Renewal review" subtitle="Decide which accounts need intervention in the next 90 days." actions={<Button intent="primary">Start review</Button>} />
    <StatusPill label="2 accounts need attention" tone="warning" detail="$280,000 at risk" />
    <div role="group" aria-label="Renewal filters"><Button onClick={() => setFilter("Needs intervention")}>Needs intervention</Button><Button onClick={() => setFilter("All renewals")}>All renewals</Button></div>
    <DataTableComposition spec={{ type: "data_table", config: { density: "compact", columns: [
      { id: "account", label: "Account" }, { id: "owner", label: "Owner" }, { id: "renewal", label: "Renews" },
      { id: "value", label: "ARR", align: "right" }, { id: "health", label: "Health" }, { id: "action", label: "Next action" },
    ], rows: visible } }} />
    <aside aria-label="Selected renewal"><h2>Northstar Health</h2><p>Usage is down 18% and the executive sponsor changed 12 days ago.</p><Button>Open account review</Button></aside>
  </main>;
}`,
    },
  ],
  manifest: {
    version: 1,
    screens: [
      {
        id: "renewal-queue",
        title: "Renewal queue",
        route: "/",
        entry: "src/routes/index.tsx",
      },
    ],
    productionComponents: [
      { name: "Button", source: "@autograph/components" },
      { name: "PageHeader", source: "@autograph/components" },
      { name: "PageTabs", source: "@autograph/components" },
      { name: "StatusPill", source: "@autograph/components" },
    ],
    productionCompositions: [
      { name: "DataTableComposition", source: "@autograph/compositions" },
    ],
    productionIcons: [],
    fixtureFacts: [
      {
        id: "renewal-window",
        statement: "The review window is 90 days and contains three renewals.",
        routes: ["/"],
      },
    ],
    decisions: [],
    assumptions: [
      {
        id: "queue-first",
        statement:
          "Customer-success managers start from a prioritized renewal queue.",
        routes: ["/"],
      },
    ],
    openQuestions: [
      {
        id: "intervention-owner",
        statement: "Should the first version assign an intervention owner?",
        routes: ["/"],
      },
    ],
    implementationNotes: [
      {
        visibleElement: "Open account review",
        productionMeaning:
          "Navigates to evidence and recommended next actions for the selected account.",
        routes: ["/"],
      },
    ],
  },
  catalogGaps: [],
} satisfies UiPreviewInput;

/** Browser transport derived from the React fixture. Visual semantics are
 * labelled with the public Arrusted elements that own each rendered region. */
