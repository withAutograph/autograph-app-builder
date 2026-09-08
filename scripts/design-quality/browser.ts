import { chromium, type Page } from "playwright";
import * as axe from "axe-core";
import { join } from "node:path";
import { z } from "zod";
import type { Observation } from "./evidence";
import {
  generatedSignatureSelector,
  signatureAttribution,
  uniqueIntrinsicSignature,
  type IntrinsicClassSignature,
} from "./class-evidence";

export const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "desktop-wide", width: 1920, height: 1080 },
  { name: "desktop-window", width: 1024, height: 768 },
];
export const scenariosSchema = z.array(
  z.object({
    name: z.string().min(1),
    steps: z.array(
      z
        .object({
          action: z.enum(["click", "fill", "select"]),
          role: z.string().optional(),
          name: z.string().optional(),
          selector: z.string().optional(),
          value: z.string().optional(),
        })
        .refine(
          (s) => Boolean(s.selector || (s.role && s.name)),
          "Select a role/name or selector",
        ),
    ),
    expect: z.object({ text: z.string().optional() }).optional(),
  }),
);
export type Scenario = z.infer<typeof scenariosSchema>[number];
export type Category =
  "color" | "typography" | "spacing" | "radius" | "border" | "shadow";
export const properties: Record<string, Category> = {
  color: "color",
  "background-color": "color",
  "font-family": "typography",
  "font-size": "typography",
  "font-weight": "typography",
  "line-height": "typography",
  "letter-spacing": "typography",
  "padding-top": "spacing",
  "padding-right": "spacing",
  "padding-bottom": "spacing",
  "padding-left": "spacing",
  "margin-top": "spacing",
  "margin-bottom": "spacing",
  "column-gap": "spacing",
  "row-gap": "spacing",
  "border-top-left-radius": "radius",
  "border-top-width": "border",
  "border-top-color": "border",
  "box-shadow": "shadow",
};
export function classifyStyle(
  values: string[],
  computed: string,
  tokenValues: string[],
) {
  const unique = [...new Set(values)];
  if (unique.length !== 1) return "unassessed" as const;
  const value = unique[0]!;
  if (/var\(--/.test(value)) return "token-reference" as const;
  if (
    /^(0(?:px|rem|em)?|auto|normal|none|inherit|initial|transparent)$/.test(
      value,
    ) ||
    /%|\d(?:\.\d+)?fr\b/.test(value)
  )
    return "structural" as const;
  return tokenValues.includes(computed)
    ? ("matching-literal" as const)
    : ("unmatched-literal" as const);
}

type BrowserStyleObservation = Observation & {
  node: string;
  property: string;
  category: Category;
  computed: string;
  declarations: string[];
  origin: string;
  selector?: string;
  cssSource?: { path: string; line: number; column?: number };
  originCandidate?: {
    provenance: "generated" | "shared";
    reason: string;
    source: { path: string; line: number; column: number };
  };
};

function domClassSignature(node: { nodeName?: string; attributes?: string[] }) {
  const index = node.attributes?.findIndex((value) => value === "class") ?? -1;
  const value = index >= 0 ? node.attributes?.[index + 1] : undefined;
  return value && node.nodeName
    ? {
        tag: node.nodeName.toLowerCase(),
        classes: [...new Set(value.split(/\s+/).filter(Boolean))].sort(),
      }
    : undefined;
}

function matchedSelector(match: {
  matchingSelectors?: number[];
  rule: { selectorList?: { selectors?: Array<{ text?: string }> } };
}) {
  const selectors = match.rule.selectorList?.selectors;
  if (!selectors?.length) return undefined;
  const indexes = match.matchingSelectors;
  if (indexes?.length === 1) return selectors[indexes[0]]?.text;
  return selectors.length === 1 ? selectors[0]?.text : undefined;
}

export const sourcePath = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "file:"
      ? decodeURIComponent(url.pathname)
      : url.pathname;
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
};

export const generatedSource = (
  path: string | undefined,
  generated: string[],
) => {
  if (!path) return false;
  const clean = path.replace(/\\/g, "/");
  return generated.some((candidate) => {
    const expected = sourcePath(candidate)?.replace(/\\/g, "/");
    return Boolean(
      expected &&
      (clean === expected ||
        clean.endsWith(`/${expected.replace(/^\/+/, "")}`)),
    );
  });
};

// A stylesheet URL alone is not provenance. The only shared source family we
// recognise in browser evidence is the checked-in Arrusted design-system tree.
export const arrustedSharedSource = (path: string | undefined) =>
  Boolean(
    path?.replace(/\\/g, "/").match(/(?:^|\/)packages\/design-systems(?:\/|$)/),
  );

export async function measurePage(page: Page) {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async () => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x + scrollX,
        y: r.y + scrollY,
        width: r.width,
        height: r.height,
      };
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect(),
        s = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.visibility !== "hidden" &&
        s.display !== "none"
      );
    };
    const label = (el: Element) =>
      (el.getAttribute("aria-label") || el.textContent || el.tagName)
        .trim()
        .slice(0, 160);
    const findings: Array<{
      kind: string;
      description: string;
      region: ReturnType<typeof rect>;
      reviewRequired: boolean;
    }> = [];
    const scrolling = [...document.querySelectorAll("*")].filter(
      (el) =>
        visible(el) &&
        el.scrollWidth > el.clientWidth + 2 &&
        /auto|scroll/.test(getComputedStyle(el).overflowX),
    );
    if (document.documentElement.scrollWidth > innerWidth + 2)
      findings.push({
        kind: "document-overflow",
        description:
          "Page is wider than the viewport; review whether horizontal scrolling is intended.",
        region: rect(document.documentElement),
        reviewRequired: true,
      });
    const controls = [
      ...document.querySelectorAll(
        "button,input,select,textarea,a[href],[role=button]",
      ),
    ].filter(visible);
    for (const el of controls) {
      let parent = el.parentElement;
      while (parent) {
        const s = getComputedStyle(parent),
          a = el.getBoundingClientRect(),
          b = parent.getBoundingClientRect();
        if (
          /hidden|clip/.test(s.overflowX) &&
          (a.left < b.left - 2 || a.right > b.right + 2)
        ) {
          findings.push({
            kind: "possible-clipping",
            description: `${label(el)} extends beyond a clipped ancestor.`,
            region: rect(el),
            reviewRequired: true,
          });
          break;
        }
        parent = parent.parentElement;
      }
    }
    for (const table of document.querySelectorAll(
      "table,[role=table],[role=grid]",
    )) {
      const headers = [
        ...table.querySelectorAll("th,[role=columnheader]"),
      ].filter(visible);
      const row = [...table.querySelectorAll("tr,[role=row]")].find((r) =>
        r.querySelector("td,[role=cell],[role=gridcell]"),
      );
      const cells = row
        ? [...row.querySelectorAll("td,[role=cell],[role=gridcell]")].filter(
            visible,
          )
        : [];
      if (headers.length === cells.length)
        headers.forEach((h, i) => {
          if (
            Math.abs(
              h.getBoundingClientRect().left -
                cells[i]!.getBoundingClientRect().left,
            ) > 4
          )
            findings.push({
              kind: "possible-column-misalignment",
              description: `Column ${label(h)} and its first cell have different left edges.`,
              region: rect(h),
              reviewRequired: true,
            });
        });
    }
    // Only sibling interactive targets: generic rectangle overlap is too noisy.
    for (let i = 0; i < Math.min(controls.length, 150); i++)
      for (let j = i + 1; j < Math.min(controls.length, 150); j++) {
        const a = controls[i]!,
          b = controls[j]!;
        if (
          a.parentElement !== b.parentElement ||
          a.contains(b) ||
          b.contains(a)
        )
          continue;
        const x = a.getBoundingClientRect(),
          y = b.getBoundingClientRect();
        if (
          Math.min(x.right, y.right) - Math.max(x.left, y.left) > 4 &&
          Math.min(x.bottom, y.bottom) - Math.max(x.top, y.top) > 4
        )
          findings.push({
            kind: "possible-overlap",
            description: `Interactive targets overlap: ${label(a)} / ${label(b)}.`,
            region: rect(a),
            reviewRequired: true,
          });
      }
    const result = await (
      window as unknown as {
        axe: {
          run: () => Promise<{
            violations: Array<{
              id: string;
              impact: string;
              help: string;
              nodes: Array<{ target: string[]; failureSummary: string }>;
            }>;
            incomplete: unknown[];
          }>;
        };
      }
    ).axe.run();
    return {
      title: document.title,
      width: innerWidth,
      height: innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight,
      findings,
      intentionalScrollContainers: scrolling.map((el) => ({
        label: label(el),
        region: rect(el),
      })),
      controls: controls.map((el) => ({
        label: label(el),
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        region: rect(el),
      })),
      accessibility: {
        violations: result.violations.map((v) => ({
          id: v.id,
          impact: v.impact,
          help: v.help,
          nodes: v.nodes.map((n) => ({
            target: n.target,
            summary: n.failureSummary,
          })),
        })),
        manualReviewCount: result.incomplete.length,
      },
    };
  });
}

export async function measureStyles(
  page: Page,
  tokens: Record<string, string>,
  generatedSourcePaths: string[] = [],
  generatedClassSignatures: IntrinsicClassSignature[] = [],
  sharedClassSignatures?: IntrinsicClassSignature[],
) {
  const session = await page.context().newCDPSession(page);
  try {
    const headers = new Map<string, { sourceURL?: string }>();
    session.on(
      "CSS.styleSheetAdded",
      ({ header }: { header: { styleSheetId: string; sourceURL?: string } }) =>
        headers.set(header.styleSheetId, header),
    );
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const { root } = await session.send("DOM.getDocument");
    const { nodeIds } = await session.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: "body,body *",
    });
    const { nodeIds: interactiveNodeIds } = await session.send(
      "DOM.querySelectorAll",
      {
        nodeId: root.nodeId,
        selector:
          "button,input,select,textarea,a[href],[role=button],[role=link]",
      },
    );
    const interactiveNodes = new Set(interactiveNodeIds);
    // Resolve tokens in the active browser theme. A detached element only sees a
    // flattened default cascade and is misleading for dark or inherited themes.
    const normalized = await page.evaluate(
      ({ tokens, properties }) => {
        const el = document.createElement("span");
        el.style.cssText =
          "position:absolute;visibility:hidden;pointer-events:none";
        document.body.appendChild(el);
        const result: Record<string, string[]> = {};
        for (const prop of Object.keys(properties)) {
          result[prop] = [];
          for (const [name] of Object.entries(tokens)) {
            const relevant = prop.includes("color")
              ? name.startsWith("--color-")
              : prop.includes("font") ||
                  prop.includes("line") ||
                  prop.includes("letter")
                ? /--(font|text|leading|tracking)/.test(name)
                : prop.includes("radius")
                  ? name.includes("radius")
                  : prop.includes("shadow")
                    ? name.includes("shadow")
                    : /spacing|space|radius|border/.test(name);
            if (!relevant) continue;
            el.style.removeProperty(prop);
            el.style.setProperty(prop, `var(${name})`);
            if (el.style.getPropertyValue(prop))
              result[prop].push(getComputedStyle(el).getPropertyValue(prop));
          }
        }
        el.remove();
        return result;
      },
      { tokens, properties },
    );
    // CSS.enable normally emits existing headers, but source location is optional
    // in CDP. Missing headers deliberately remain unknown.
    const candidates: Array<{
      nodeId: number;
      model: { width: number; height: number; content: number[] };
      region: "top" | "middle" | "bottom";
      interactive: boolean;
    }> = [];
    for (const nodeId of nodeIds) {
      const { model } = await session
        .send("DOM.getBoxModel", { nodeId })
        .catch(() => ({ model: null }));
      if (!model || model.width <= 0 || model.height <= 0) continue;
      const y = model.content[1] ?? 0;
      candidates.push({
        nodeId,
        model,
        region: y < 300 ? "top" : y < 1000 ? "middle" : "bottom",
        interactive: interactiveNodes.has(nodeId),
      });
    }
    const selected: typeof candidates = [];
    const regions = ["top", "middle", "bottom"] as const;
    const buckets = regions.flatMap((region) =>
      [true, false].map((interactive) =>
        candidates.filter(
          (item) => item.region === region && item.interactive === interactive,
        ),
      ),
    );
    // Reserve controls before using a round-robin budget across each rendered
    // region and control/non-control bucket.
    for (const bucket of buckets.filter((bucket) => bucket[0]?.interactive)) {
      const candidate = bucket.shift();
      if (candidate) selected.push(candidate);
    }
    while (selected.length < 120) {
      let added = false;
      for (const bucket of buckets) {
        if (selected.length >= 120) break;
        const candidate = bucket.shift();
        if (candidate) {
          selected.push(candidate);
          added = true;
        }
      }
      if (!added) break;
    }
    const observations: BrowserStyleObservation[] = [];
    for (const { nodeId, model } of selected) {
      const described = await session.send("DOM.describeNode", { nodeId });
      const signature = domClassSignature(described.node);
      const generatedSignature = signature
        ? uniqueIntrinsicSignature(
            generatedClassSignatures,
            signature.tag,
            signature.classes,
          )
        : undefined;
      const signatureOrigin = signature
        ? signatureAttribution(
            generatedClassSignatures,
            sharedClassSignatures,
            signature.tag,
            signature.classes,
          )
        : { provenance: "unknown" as const };
      const computed = await session.send("CSS.getComputedStyleForNode", {
        nodeId,
      });
      const cv = Object.fromEntries(
        computed.computedStyle.map((p) => [p.name, p.value]),
      );
      if (cv.display === "none" || cv.visibility === "hidden") continue;
      const matched = await session.send("CSS.getMatchedStylesForNode", {
        nodeId,
      });
      for (const [property, category] of Object.entries(properties)) {
        const inline = (matched.inlineStyle?.cssProperties ?? []).filter(
          (p) => p.name === property && !p.disabled && p.parsedOk !== false,
        );
        const rules = (matched.matchedCSSRules ?? []).filter(
          (m) =>
            m.rule.origin !== "user-agent" &&
            !(m.rule.media ?? []).some((media) =>
              media.mediaList?.every((q) => !q.active),
            ),
        );
        const inherited = /^(font-|line-height|letter-spacing|color$)/.test(
          property,
        )
          ? (matched.inherited ?? []).flatMap((i) =>
              (i.matchedCSSRules ?? []).filter(
                (m) => m.rule.origin !== "user-agent",
              ),
            )
          : [];
        const own = rules.flatMap((m) =>
          m.rule.style.cssProperties
            .filter(
              (p) => p.name === property && !p.disabled && p.parsedOk !== false,
            )
            .map((p) => ({ p, rule: m.rule, selector: matchedSelector(m) })),
        );
        const declarationEntries = inline.length
          ? inline.map((p) => ({ p, rule: undefined, selector: undefined }))
          : own.length
            ? own
            : inherited.flatMap((m) =>
                m.rule.style.cssProperties
                  .filter(
                    (p) =>
                      p.name === property &&
                      !p.disabled &&
                      p.parsedOk !== false,
                  )
                  .map((p) => ({
                    p,
                    rule: m.rule,
                    selector: matchedSelector(m),
                  })),
              );
        const declarations = declarationEntries.map(({ p }) => p.value);
        const rule = declarationEntries[0]?.rule;
        const selector = declarationEntries[0]?.selector;
        const styleSheetId = rule?.styleSheetId ?? rule?.style?.styleSheetId;
        const path = sourcePath(
          styleSheetId ? headers.get(styleSheetId)?.sourceURL : undefined,
        );
        const signatureGenerated =
          signatureOrigin.provenance === "generated" &&
          generatedSignatureSelector(generatedSignature, selector);
        // A shared component can assemble the same classes at runtime (including
        // through spreads), so a signature is reviewer evidence, never scored
        // declaration provenance. A direct stylesheet source is required.
        const generated = generatedSource(path, generatedSourcePaths);
        const inheritedDeclaration =
          !inline.length && !own.length && declarationEntries.length > 0;
        let classification: string = classifyStyle(
          declarations,
          cv[property] ?? "",
          normalized[property] ?? [],
        );
        if (
          classification === "token-reference" &&
          declarations.some((v) =>
            [...v.matchAll(/var\((--[\w-]+)/g)].some((m) => !(m[1]! in tokens)),
          )
        )
          classification = "unassessed";
        if (classification === "token-reference")
          classification = "semantic-token-reference";
        if (generated && classification === "unmatched-literal")
          classification = "generated-override";
        if (
          !generated &&
          arrustedSharedSource(path) &&
          classification !== "semantic-token-reference" &&
          classification !== "matching-literal" &&
          classification !== "structural"
        )
          classification = "inherited-shared";
        if (
          classification === "unassessed" ||
          classification === "unmatched-literal"
        )
          classification = "unknown";
        // Structural layout values are not adherence evidence, so exclude them
        // entirely rather than allowing downstream global scores to count them.
        if (classification === "structural") continue;
        const provenance: Observation["provenance"] = generated
          ? "generated"
          : arrustedSharedSource(path)
            ? "shared"
            : "unknown";
        const quad = model.content;
        const region = {
          x: quad[0] ?? 0,
          y: quad[1] ?? 0,
          width: model.width,
          height: model.height,
        };
        const cssSource = path
          ? {
              path,
              line: (rule?.style?.range?.startLine ?? 0) + 1,
              column: (rule?.style?.range?.startColumn ?? 0) + 1,
            }
          : undefined;
        const originCandidate =
          signatureGenerated && signatureOrigin.source
            ? {
                provenance: "generated" as const,
                reason:
                  "Exact rendered intrinsic tag/class signature and simple matched class selector match generated source; shared runtime assembly remains possible.",
                source: signatureOrigin.source,
              }
            : undefined;
        const source = cssSource;
        observations.push({
          node: `node-${nodeId}`,
          property,
          category,
          computed: cv[property] ?? "",
          classification,
          declarations: [...new Set(declarations)],
          origin: generated
            ? "generated-rule"
            : provenance === "shared" && inheritedDeclaration
              ? "inherited-shared"
              : provenance === "shared"
                ? "shared-rule"
                : inline.length
                  ? "inline"
                  : "unknown",
          id: `style-${nodeId}-${property}`,
          dimension: "styling",
          verdict:
            provenance === "generated" &&
            classification === "semantic-token-reference"
              ? "conforming"
              : provenance === "generated" &&
                  (classification === "matching-literal" ||
                    classification === "generated-override")
                ? "nonconforming"
                : "unassessed",
          provenance,
          evidence: "browser",
          summary: originCandidate
            ? `${property}: ${classification}; generated origin candidate requires review.`
            : `${property}: ${classification}`,
          source,
          selector,
          cssSource,
          originCandidate,
          region,
        });
      }
    }
    const categories = Object.fromEntries(
      [...new Set(Object.values(properties))].map((category) => {
        const items = observations.filter(
          (o) => o.category === category && o.classification !== "structural",
        );
        const counts = Object.fromEntries(
          [
            "semantic-token-reference",
            "matching-literal",
            "generated-override",
            "inherited-shared",
            "unknown",
          ].map((key) => [
            key,
            items.filter((o) => o.classification === key).length,
          ]),
        );
        const assessed = items.filter(
          (item) => item.verdict !== "unassessed",
        ).length;
        return [
          category,
          {
            counts,
            assessed,
            total: items.length,
            coveragePercent: items.length
              ? Math.round((assessed / items.length) * 100)
              : null,
            tokenReferencePercent: assessed
              ? Math.round(
                  (items.filter(
                    (item) =>
                      item.provenance === "generated" &&
                      item.classification === "semantic-token-reference",
                  ).length /
                    assessed) *
                    100,
                )
              : null,
          },
        ];
      }),
    );
    return {
      sampledElements: selected.length,
      totalDomElements: nodeIds.length,
      sampling: {
        eligible: candidates.length,
        sampled: selected.length,
        coveragePercent: candidates.length
          ? Math.round((selected.length / candidates.length) * 100)
          : null,
        regions: Object.fromEntries(
          (["top", "middle", "bottom"] as const).map((region) => [
            region,
            {
              eligible: candidates.filter((item) => item.region === region)
                .length,
              sampled: selected.filter((item) => item.region === region).length,
            },
          ]),
        ),
      },
      categories,
      observations,
      limitations: [
        "Conservative matched-style evidence, not a full CSS cascade or React component provenance proof.",
        "Conflicting declarations, unknown variables and shorthand-only properties remain unassessed. Sampling is capped at 120 eligible elements and diversified by rendered region.",
        "A shared bundle is never treated as positive generated adherence. Source provenance is unknown unless CDP provides a source URL matching an explicit generated path.",
        "Intrinsic tag/class matches are reviewer-facing generated-origin candidates only. Shared components can assemble identical classes dynamically, so they remain unknown and unassessed without direct stylesheet provenance.",
      ],
    };
  } finally {
    await session.detach();
  }
}

export async function capturePreview(input: {
  url: string;
  output: string;
  tokens: Record<string, string>;
  scenarios: Scenario[];
  generatedSourcePaths?: string[];
  generatedClassSignatures?: IntrinsicClassSignature[];
  sharedClassSignatures?: IntrinsicClassSignature[];
}) {
  const browser = await chromium.launch();
  const captures = [];
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      // tsx preserves local function names using this helper when serializing
      // page.evaluate callbacks. Install it only in this disposable QA context.
      await context.addInitScript("globalThis.__name = (value) => value;");
      const page = await context.newPage();
      // Never attach project OIDC, cookies, or provider headers to preview requests.
      await page.goto(input.url, { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready);
      for (let index = 0; index <= input.scenarios.length; index++) {
        const scenario = index === 0 ? undefined : input.scenarios[index - 1];
        let interaction: { status: string; expectedText?: string } = {
          status: "not-run",
        };
        if (scenario) {
          await page.reload({ waitUntil: "load" });
          try {
            for (const step of scenario.steps) {
              const locator = step.selector
                ? page.locator(step.selector)
                : page.getByRole(
                    step.role as Parameters<Page["getByRole"]>[0],
                    { name: step.name, exact: true },
                  );
              if (step.action === "click") await locator.click();
              else if (step.action === "fill")
                await locator.fill(step.value ?? "");
              else await locator.selectOption({ label: step.value ?? "" });
            }
            if (scenario.expect?.text)
              await page
                .getByText(scenario.expect.text, { exact: false })
                .first()
                .waitFor({ state: "visible" });
            interaction = {
              status: "passed",
              expectedText: scenario.expect?.text,
            };
          } catch {
            interaction = {
              status: "failed",
              expectedText: scenario.expect?.text,
            };
          }
        }
        const name = `${viewport.name}-${index}`;
        const measurements = await measurePage(page);
        const styles =
          index === 0
            ? await measureStyles(
                page,
                input.tokens,
                input.generatedSourcePaths,
                input.generatedClassSignatures,
                input.sharedClassSignatures,
              )
            : undefined;
        if (styles)
          styles.observations.forEach((observation) => {
            observation.capture = name;
            observation.id = `${name}-${observation.id}`;
          });
        const path = join(input.output, `${name}.png`);
        await page.screenshot({ path, fullPage: true });
        captures.push({
          name,
          state: scenario?.name ?? "initial",
          path,
          width: viewport.width,
          height: Math.max(viewport.height, measurements.documentHeight),
          measurements,
          styles,
          interaction,
        });
      }
      await context.close();
    }
    return captures;
  } finally {
    await browser.close();
  }
}
