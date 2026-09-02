import { validAppId } from "./workflow-state";

export type DevelopmentPrototypeInput = {
  appId: string;
  brief: string;
  productName?: string;
  interfacePattern?: "queue" | "dashboard" | "form";
};

export type DevelopmentPrototypeBundle = {
  indexHtml: string;
  decisionsMarkdown: string;
  appSpecMarkdown: string;
};

function text(value: string, maximum = 240) {
  return value.replace(/\s+/gu, " ").trim().slice(0, maximum);
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function displayName(appId: string) {
  return appId
    .replace(/-/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

/**
 * Local development needs a fast first visible result, not a model-authored
 * multi-hundred-kilobyte transport payload. This deliberately creates a small,
 * revisable prototype bundle from concise product choices. Hosted callers keep
 * the authored-bundle contract.
 */
export function developmentPrototypeBundle(
  input: DevelopmentPrototypeInput,
): DevelopmentPrototypeBundle {
  if (!validAppId(input.appId))
    throw new Error("App id must be one lowercase kebab-case segment.");
  const brief = text(input.brief);
  if (brief.length === 0)
    throw new Error("Development prototype brief is required.");
  const name = text(input.productName ?? displayName(input.appId), 120);
  const pattern = input.interfacePattern ?? "queue";
  const escapedName = escapeHtml(name);
  const escapedBrief = escapeHtml(brief);
  const patternLabel =
    pattern === "dashboard"
      ? "work dashboard"
      : pattern === "form"
        ? "guided intake"
        : "review queue";
  const path = `prototype/${input.appId}/index.html`;

  return {
    indexHtml: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapedName}</title><style>:root{font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#16221c;background:#f4f7f5}*{box-sizing:border-box}body{margin:0}header{padding:28px max(20px,calc((100vw - 1040px)/2));background:#163d2e;color:#fff}header p{color:#c9ded3;max-width:720px}main{max-width:1040px;margin:0 auto;padding:24px;display:grid;grid-template-columns:minmax(260px,.9fr)minmax(320px,1.2fr);gap:18px}.card{background:#fff;border:1px solid #dce8e1;border-radius:16px;padding:20px;box-shadow:0 8px 28px #153c2d12}.item{width:100%;border:0;background:#f4f8f5;border-radius:10px;text-align:left;padding:14px;margin:8px 0;font:inherit;cursor:pointer}.item[aria-current=true]{outline:2px solid #297653;background:#eaf6ef}.tag{display:inline-block;background:#fff1d7;color:#7b4a0b;border-radius:999px;padding:4px 8px;font-size:12px}.facts{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}.fact{padding:12px;border-radius:10px;background:#f4f8f5}.muted{color:#607168}.actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}button{font:inherit;padding:9px 12px;border-radius:8px;border:1px solid #bcd0c3;background:#fff;cursor:pointer}.primary{background:#216b4d;border-color:#216b4d;color:#fff}@media(max-width:720px){main{grid-template-columns:1fr;padding:16px}.facts{grid-template-columns:1fr}}</style></head><body><header><h1>${escapedName}</h1><p>${escapedBrief}</p></header><main><section class="card" aria-labelledby="work-title"><h2 id="work-title">${patternLabel}</h2><p class="muted">Prioritize the next item, review its context, and move work forward.</p><button class="item" aria-current="true" data-name="Needs attention"><strong>Needs attention</strong><br><span class="muted">Review the latest exception and choose the next step.</span></button><button class="item" data-name="In progress"><strong>In progress</strong><br><span class="muted">Work that is already being resolved.</span></button><button class="item" data-name="Ready to complete"><strong>Ready to complete</strong><br><span class="muted">Items waiting for final confirmation.</span></button></section><section class="card" aria-labelledby="detail-title"><span class="tag">Prototype</span><h2 id="detail-title">Needs attention</h2><p class="muted">A focused detail view keeps the next decision and its context together.</p><div class="facts"><div class="fact"><strong>Owner</strong><br><span class="muted">Operations</span></div><div class="fact"><strong>State</strong><br><span class="muted">Needs review</span></div></div><h3>Suggested next step</h3><p>Review the available context, resolve the exception, and leave a clear handoff for the next person.</p><div class="actions"><button>Request changes</button><button class="primary">Move forward</button></div></section></main><script>document.querySelectorAll('.item').forEach((item)=>item.addEventListener('click',()=>{document.querySelectorAll('.item').forEach((candidate)=>candidate.removeAttribute('aria-current'));item.setAttribute('aria-current','true');document.querySelector('#detail-title').textContent=item.dataset.name}))</script></body></html>`,
    decisionsMarkdown: `# ${name} decisions\n\n- \`agent_inferred\`: ${name} starts with a ${patternLabel} so people can focus on the next useful decision.\n- \`agent_inferred\`: Detail work stays in context beside the active item.\n- \`product_brief\`: ${brief}\n- \`deferred\`: Integration, role, and policy details remain revisable product decisions.\n`,
    appSpecMarkdown: `## Status and prototype\n\nThe usable prototype is at ${path}.\n\n## User and outcome\n\nPeople move ${name} work from an exception or request to a clear next step.\n\n## Interfaces and navigation\n\nA ${patternLabel} opens one focused detail view.\n\n## Controls and behavior\n\nSelecting an item updates its detail view; move-forward and request-changes actions remain reviewable defaults.\n\n## Data model\n\nWork items, owners, states, and next-step notes are provisional product objects.\n\n## Integrations and reconciliation\n\nExternal systems are deferred until product review.\n\n## Temporal semantics\n\nThe initial experience presents current work; historical and scheduled behavior are deferred.\n\n## Writes, review, and authority\n\nPrototype actions show intended workflow only and do not define production write authority.\n\n## Access and tenancy\n\nWork is tenant-scoped; role details are provisional.\n\n## Agent behavior\n\nThe agent can summarize work and recommend the next step but does not complete it autonomously.\n\n## Operational states\n\nNeeds attention, in progress, and ready-to-complete work are represented.\n\n## Defaults, non-goals, and risks\n\nThe initial ${patternLabel} is a revisable default; integrations and final policy remain out of scope.\n\n## Acceptance walkthrough\n\nOpen each work item, confirm the detail view changes, and review the suggested next step.\n\n## Build handoff\n\n\`\`\`json\n{\n  "status": "build-ready",\n  "owner": "operations",\n  "schema": { "kind": "none" },\n  "additionalPublicRoutes": [],\n  "optionalCapabilities": {\n    "integrations": [],\n    "hostedResources": []\n  }\n}\n\`\`\``,
  };
}
