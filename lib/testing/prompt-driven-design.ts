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
export function renderRenewalReviewFixture(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Renewal review</title><style>
:root{--page:#fafaf9;--surface:#fefefe;--subtle:#f8f8f8;--selected:#f5f4ff;--ink:#292929;--secondary:#4e5253;--muted:#686b6c;--border:rgba(41,41,41,.08);--strong:rgba(41,41,41,.16);--primary:#8192ff;--primary-hover:#6b7de2;--warning:#eb8526;--warning-bg:#ffeede;--warning-ink:#9a4a09;--success:#17b196;--font:"Inter",ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:14px/1.45 var(--font)}button{font:600 14px var(--font)}button:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.topbar{height:56px;border-bottom:1px solid var(--border);background:var(--surface);display:flex;align-items:center;padding:0 24px;gap:28px}.brand{font-weight:700}.brand span{color:var(--primary)}.tabs{display:flex;align-self:stretch}.tab{border:0;background:transparent;padding:0 18px;color:var(--secondary)}.tab.active{color:var(--ink);box-shadow:inset 0 -2px var(--primary)}main{max-width:1180px;margin:auto;padding:34px 24px 56px}.header{display:flex;align-items:flex-end;justify-content:space-between;gap:20px}.header h1{font-size:32px;line-height:1.2;letter-spacing:-.02em;margin:0}.header p{margin:6px 0 0;color:var(--secondary)}.button{height:40px;border-radius:8px;border:1px solid var(--strong);background:transparent;color:var(--secondary);padding:0 16px;cursor:pointer}.button:hover{background:rgba(41,41,41,.04)}.button.primary{border-color:transparent;background:var(--primary);color:var(--ink)}.button.primary:hover{background:var(--primary-hover)}.summary{margin-top:26px;display:flex;align-items:center;justify-content:space-between;border:1px solid var(--border);background:var(--surface);border-radius:14px;padding:18px 20px}.summary strong{display:block;font-size:16px}.summary small{color:var(--muted)}.pill{display:inline-flex;align-items:center;gap:8px;border-radius:999px;background:var(--warning-bg);color:var(--warning-ink);font-size:12px;font-weight:600;padding:6px 10px}.dot{width:8px;height:8px;border-radius:50%;background:var(--warning)}.filters{display:flex;gap:8px;margin:24px 0 12px}.filter{height:34px;border:1px solid var(--strong);border-radius:8px;background:transparent;padding:0 12px;color:var(--secondary);cursor:pointer}.filter.active{border-color:var(--primary);background:var(--selected);color:var(--ink)}.workspace{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:16px}.table-wrap,.detail{overflow:hidden;border:1px solid var(--border);border-radius:10px;background:var(--surface)}table{width:100%;border-collapse:collapse}th{background:var(--subtle);color:var(--secondary);font-size:12px;text-transform:uppercase;letter-spacing:.06em;text-align:left;padding:10px 12px;border-bottom:1px solid var(--border)}td{padding:13px 12px;border-bottom:1px solid var(--border);white-space:nowrap}tr:last-child td{border-bottom:0}tbody tr{cursor:pointer}tbody tr:hover{background:rgba(41,41,41,.025)}tbody tr.selected{background:var(--selected);box-shadow:inset 3px 0 var(--primary)}td.money{text-align:right}.health{display:inline-flex;align-items:center;gap:6px;font-size:12px}.health:before{content:"";width:7px;height:7px;border-radius:50%;background:var(--warning)}.detail{padding:22px;align-self:start}.detail .eyebrow{text-transform:uppercase;letter-spacing:.08em;font-size:11px;color:var(--muted)}.detail h2{font-size:18px;margin:8px 0}.detail p{color:var(--secondary);margin:0 0 22px}.signals{border-top:1px solid var(--border);margin:20px 0;padding-top:18px}.signal{display:flex;justify-content:space-between;margin:9px 0;color:var(--secondary)}.signal strong{color:var(--ink)}@media(max-width:720px){.topbar{padding:0 14px;gap:12px}.brand{font-size:13px}.tabs{overflow:auto}.tab{padding:0 12px;white-space:nowrap}main{padding:24px 16px}.header{align-items:flex-start;flex-direction:column}.header h1{font-size:28px}.header .button{width:100%}.summary{align-items:flex-start;gap:14px;flex-direction:column}.workspace{grid-template-columns:1fr}.table-wrap{overflow:auto}.table-wrap table{min-width:760px}.detail{order:-1}.filters{overflow:auto}.filter{white-space:nowrap}}
</style></head><body><nav class="topbar" aria-label="Product navigation"><div class="brand"><span>◉</span> Autograph · Success</div><div class="tabs" data-arrusted-component="PageTabs"><button class="tab active" aria-current="page">Renewals</button><button class="tab">Portfolio</button><button class="tab">Accounts</button></div></nav><main><header class="header" data-arrusted-component="PageHeader"><div><h1>Renewal review</h1><p>Decide which accounts need intervention in the next 90 days.</p></div><button class="button primary" data-arrusted-component="Button" id="start-review">Start review</button></header><section class="summary" aria-label="Renewal summary"><div><strong>$352,000 renewing in 90 days</strong><small>Across 3 customer accounts</small></div><div class="pill" data-arrusted-component="StatusPill"><span class="dot"></span>2 accounts need attention · $280,000 at risk</div></section><div class="filters" role="group" aria-label="Renewal filters"><button class="filter active" data-filter="attention">Needs intervention</button><button class="filter" data-filter="all">All renewals</button></div><div class="workspace"><section class="table-wrap" aria-label="Renewal queue" data-arrusted-composition="DataTableComposition"><table><thead><tr><th>Account</th><th>Owner</th><th>Renews</th><th>ARR</th><th>Health</th><th>Next action</th></tr></thead><tbody><tr class="selected" tabindex="0" data-account="Northstar Health" data-detail="Usage is down 18% and the executive sponsor changed 12 days ago."><td><strong>Northstar Health</strong></td><td>Maya Chen</td><td>Sep 23</td><td class="money">$184,000</td><td><span class="health">At risk</span></td><td>Executive alignment</td></tr><tr tabindex="0" data-account="Kiteworks GmbH" data-detail="Product adoption is flat and the success plan has not been confirmed."><td><strong>Kiteworks GmbH</strong></td><td>Jon Bell</td><td>Oct 08</td><td class="money">$96,000</td><td><span class="health">Watch</span></td><td>Confirm adoption plan</td></tr><tr class="healthy" tabindex="0" data-account="Mercury Labs" data-detail="Usage and stakeholder engagement are on plan."><td><strong>Mercury Labs</strong></td><td>Ari Jones</td><td>Oct 21</td><td class="money">$72,000</td><td><span class="health" style="--warning:var(--success)">Healthy</span></td><td>Prepare renewal</td></tr></tbody></table></section><aside class="detail" aria-label="Selected renewal"><div class="eyebrow">Selected account</div><h2 id="detail-title">Northstar Health</h2><p id="detail-copy">Usage is down 18% and the executive sponsor changed 12 days ago.</p><div class="signals"><div class="signal"><span>Renewal</span><strong>21 days</strong></div><div class="signal"><span>ARR</span><strong>$184,000</strong></div><div class="signal"><span>Health</span><strong>At risk</strong></div></div><button class="button" data-arrusted-component="Button">Open account review</button></aside></div></main><script>const rows=[...document.querySelectorAll('tbody tr')];const title=document.querySelector('#detail-title');const copy=document.querySelector('#detail-copy');function select(row){rows.forEach(item=>item.classList.toggle('selected',item===row));title.textContent=row.dataset.account;copy.textContent=row.dataset.detail}rows.forEach(row=>{row.addEventListener('click',()=>select(row));row.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();select(row)}})});document.querySelectorAll('[data-filter]').forEach(button=>button.addEventListener('click',()=>{document.querySelectorAll('[data-filter]').forEach(item=>item.classList.toggle('active',item===button));document.querySelector('.healthy').hidden=button.dataset.filter==='attention'}));document.querySelector('#start-review').addEventListener('click',()=>select(rows[0]));</script></body></html>`;
}
