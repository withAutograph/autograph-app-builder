import { chromium, type Page } from "playwright";
import * as axe from "axe-core";
import { join } from "node:path";
import { z } from "zod";
import type { Observation } from "./evidence";
import {
  classTokenAttribution,
  generatedSignatureSelector,
  signatureAttribution,
  uniqueIntrinsicSignature,
  type ClassTokenEvidence,
  type IntrinsicClassSignature,
} from "./class-evidence";
import { generatedCssRule, type CssRuleEvidence } from "./css-evidence";
import { originalCssSource, type CssSourceMap } from "./css-source-map";

export const viewports = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "desktop-wide", width: 1920, height: 1080 },
  { name: "desktop-window", width: 1024, height: 768 },
];

export type DesktopSize = { width: number; height: number };

/** Parses an opt-in desktop window size without imposing a width policy. */
export function parseAdditionalDesktopSize(value: string): DesktopSize {
  const match = /^([1-9]\d*)x([1-9]\d*)$/u.exec(value);
  if (!match) throw new Error("Use WIDTHxHEIGHT with positive integer dimensions");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height))
    throw new Error("Desktop dimensions must be safe integers");
  return { width, height };
}

export function captureViewports(additionalDesktopSize?: DesktopSize) {
  return additionalDesktopSize
    ? [
        ...viewports,
        {
          name: `desktop-custom-${additionalDesktopSize.width}x${additionalDesktopSize.height}`,
          ...additionalDesktopSize,
        },
      ]
    : viewports;
}
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
        .refine((s) => Boolean(s.selector || (s.role && s.name)), "Select a role/name or selector"),
    ),
    expect: z.object({ text: z.string().optional() }).optional(),
  }),
);
export type Scenario = z.infer<typeof scenariosSchema>[number];
export type Category = "color" | "typography" | "spacing" | "radius" | "border" | "shadow";
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
export function classifyStyle(values: string[], computed: string, tokenValues: string[]) {
  const unique = [...new Set(values)];
  if (unique.length !== 1) return "unassessed" as const;
  const value = unique[0]!;
  if (/var\(--/u.test(value)) return "token-reference" as const;
  if (
    /^(0(?:px|rem|em)?|auto|normal|none|inherit|initial|transparent)$/u.test(value) ||
    /%|\d(?:\.\d+)?fr\b/u.test(value)
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
  const index = node.attributes?.indexOf("class") ?? -1;
  const value = index >= 0 ? node.attributes?.[index + 1] : undefined;
  return value && node.nodeName
    ? {
        tag: node.nodeName.toLowerCase(),
        classes: [...new Set(value.split(/\s+/u).filter(Boolean))].toSorted(),
      }
    : undefined;
}

function matchedSelector(match: {
  matchingSelectors?: number[];
  rule: { selectorList?: { selectors?: { text?: string }[] } };
}) {
  const selectors = match.rule.selectorList?.selectors;
  if (!selectors?.length) return undefined;
  const indexes = match.matchingSelectors;
  if (indexes?.length === 1) return selectors[indexes[0]]?.text;
  return selectors.length === 1 ? selectors[0]?.text : undefined;
}

/**
 * CDP expands `gap` into empty row/column longhands. A shorthand can support
 * either axis only when it contains exactly one top-level CSS value; two-value
 * gaps deliberately remain ambiguous rather than being assigned to both axes.
 */
function singleGapValue(value: string): string | undefined {
  const candidate = value.trim();
  if (!candidate) return undefined;
  let depth = 0;
  for (const character of candidate) {
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth < 0) return undefined;
    } else if (depth === 0 && /\s/u.test(character)) return undefined;
  }
  return depth === 0 ? candidate : undefined;
}

export const sourcePath = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : url.pathname;
  } catch {
    return value.split(/[?#]/u, 1)[0];
  }
};

export const generatedSource = (path: string | undefined, generated: string[]) => {
  if (!path) return false;
  const clean = path.replaceAll("\\", "/");
  return generated.some((candidate) => {
    const expected = sourcePath(candidate)?.replaceAll("\\", "/");
    return Boolean(
      expected && (clean === expected || clean.endsWith(`/${expected.replace(/^\/+/u, "")}`)),
    );
  });
};

// A stylesheet URL alone is not provenance. The only shared source family we
// recognise in browser evidence is the checked-in Arrusted design-system tree.
export const arrustedSharedSource = (path: string | undefined) =>
  Boolean(path?.replaceAll("\\", "/").match(/(?:^|\/)packages\/design-systems(?:\/|$)/u));

type CssSourceFile = { path: string; content: string };

/**
 * Verify that a rendered declaration maps to one exact checked-in shared CSS
 * declaration. A map path, a matching utility name, or a matching value alone
 * is deliberately insufficient provenance.
 */
export function mappedSharedCssRule(input: {
  map: CssSourceMap | undefined;
  mapped: ReturnType<typeof originalCssSource>;
  property: string;
  value: string | undefined;
  sharedCssRules: CssRuleEvidence[];
  sharedCssSourceFiles: CssSourceFile[];
}) {
  const { map, mapped, property, value, sharedCssRules, sharedCssSourceFiles } = input;
  if (!map || !mapped || value === undefined) return undefined;
  const sourceContent = map.sourcesContent?.[mapped.sourceIndex];
  if (typeof sourceContent !== "string") return undefined;
  const files = sharedCssSourceFiles.filter(
    (file) =>
      arrustedSharedSource(file.path) &&
      generatedSource(mapped.path, [file.path]) &&
      file.content === sourceContent,
  );
  if (files.length !== 1) return undefined;
  const declarations = sharedCssRules.filter(
    (candidate) =>
      candidate.source.path === files[0]!.path &&
      candidate.source.line === mapped.line &&
      candidate.source.column === mapped.column &&
      candidate.property === property &&
      candidate.value === value,
  );
  return declarations.length === 1 ? declarations[0] : undefined;
}

/** Wait for currently active finite CSS motion before sampling visual evidence. */
export async function settleFiniteMotion(page: Page) {
  await page.evaluate(async () => {
    // Let hydration/class updates start their CSS transitions before taking the
    // animation snapshot. A second frame is enough without adding a timer gate.
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => resolve());
      });
    });
    const finite = document.getAnimations().filter((motion) => {
      if (motion.playState !== "running" && !motion.pending) return false;
      const timing = motion.effect?.getComputedTiming();
      const iterations = timing?.iterations ?? 1;
      return Number.isFinite(iterations) && Number.isFinite(timing?.duration);
    });
    await Promise.all(finite.map((motion) => motion.finished.catch(() => undefined)));
  });
}

export async function measurePage(page: Page) {
  await settleFiniteMotion(page);
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async () => {
    // Keep DOM measurement helpers together with browser traversal.
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x + scrollX,
        y: r.y + scrollY,
        width: r.width,
        height: r.height,
      };
    };
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    // oxlint-disable-next-line unicorn/consistent-function-scoping
    const label = (el: Element) =>
      (el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 160);
    const findings: {
      kind: string;
      description: string;
      region: ReturnType<typeof rect>;
      reviewRequired: boolean;
    }[] = [];
    const scrolling = [...document.querySelectorAll("*")].flatMap((el) => {
      if (!visible(el)) return [];
      const style = getComputedStyle(el);
      const axes: ("x" | "y")[] = [];
      if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/u.test(style.overflowX))
        axes.push("x");
      if (el.scrollHeight > el.clientHeight + 2 && /auto|scroll/u.test(style.overflowY))
        axes.push("y");
      return axes.map((axis) => ({
        el,
        axis,
        scrollWidth: el.scrollWidth,
        scrollHeight: el.scrollHeight,
        clientWidth: el.clientWidth,
        clientHeight: el.clientHeight,
      }));
    });
    if (document.documentElement.scrollWidth > innerWidth + 2)
      findings.push({
        kind: "document-overflow",
        description:
          "Page is wider than the viewport; review whether horizontal scrolling is intended.",
        region: rect(document.documentElement),
        reviewRequired: true,
      });
    const controls = [
      ...document.querySelectorAll("button,input,select,textarea,a[href],[role=button]"),
    ].filter(visible);
    for (const el of controls) {
      let parent = el.parentElement;
      while (parent) {
        const s = getComputedStyle(parent);
        const a = el.getBoundingClientRect();
        const b = parent.getBoundingClientRect();
        if (/hidden|clip/u.test(s.overflowX) && (a.left < b.left - 2 || a.right > b.right + 2)) {
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
    for (const table of document.querySelectorAll("table,[role=table],[role=grid]")) {
      const headers = [...table.querySelectorAll("th,[role=columnheader]")].filter(visible);
      const row = [...table.querySelectorAll("tr,[role=row]")].find((r) =>
        r.querySelector("td,[role=cell],[role=gridcell]"),
      );
      const cells = row
        ? [...row.querySelectorAll("td,[role=cell],[role=gridcell]")].filter(visible)
        : [];
      if (headers.length === cells.length)
        for (const [i, h] of headers.entries()) {
          if (Math.abs(h.getBoundingClientRect().left - cells[i]!.getBoundingClientRect().left) > 4)
            findings.push({
              kind: "possible-column-misalignment",
              description: `Column ${label(h)} and its first cell have different left edges.`,
              region: rect(h),
              reviewRequired: true,
            });
        }
    }
    // Only sibling interactive targets: generic rectangle overlap is too noisy.
    for (let i = 0; i < Math.min(controls.length, 150); i += 1)
      for (let j = i + 1; j < Math.min(controls.length, 150); j += 1) {
        const a = controls[i]!;
        const b = controls[j]!;
        if (a.parentElement !== b.parentElement || a.contains(b) || b.contains(a)) continue;
        const x = a.getBoundingClientRect();
        const y = b.getBoundingClientRect();
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
            violations: {
              id: string;
              impact: string;
              help: string;
              nodes: { target: string[]; failureSummary: string }[];
            }[];
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
      // Diagnostics only: an intentional scroll region is not an automatic
      // pass/fail conclusion about the surrounding layout.
      intentionalScrollContainers: scrolling.map((scrolling) => ({
        label: label(scrolling.el),
        axis: scrolling.axis,
        scrollWidth: scrolling.scrollWidth,
        scrollHeight: scrolling.scrollHeight,
        clientWidth: scrolling.clientWidth,
        clientHeight: scrolling.clientHeight,
        region: rect(scrolling.el),
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
  generatedCssRules: CssRuleEvidence[] = [],
  sharedCssRules: CssRuleEvidence[] = [],
  generatedCssSourceFiles: { path: string; content: string }[] = [],
  sharedCssSourceFiles: CssSourceFile[] = [],
  generatedClassTokens: ClassTokenEvidence[] = [],
  sharedClassTokens?: ClassTokenEvidence[],
) {
  await settleFiniteMotion(page);
  const session = await page.context().newCDPSession(page);
  try {
    const headers = new Map<string, { sourceURL?: string; sourceMapURL?: string }>();
    session.on(
      "CSS.styleSheetAdded",
      ({
        header,
      }: {
        header: {
          styleSheetId: string;
          sourceURL?: string;
          sourceMapURL?: string;
        };
      }) => headers.set(header.styleSheetId, header),
    );
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const sourceMaps = new Map<string, CssSourceMap | undefined>();
    const sourceMapFor = async (styleSheetId: string | undefined) => {
      if (!styleSheetId) return undefined;
      if (sourceMaps.has(styleSheetId)) return sourceMaps.get(styleSheetId);
      const header = headers.get(styleSheetId);
      const css = await session
        .send("CSS.getStyleSheetText", { styleSheetId })
        .then((result: { text: string }) => result.text)
        .catch(() => "");
      const declared = /\/[*]#\s*sourceMappingURL=([^\s*]+)\s*[*]\//u.exec(css)?.[1];
      // CDP may report optional URLs as empty strings. In that case the
      // stylesheet's sourceMappingURL comment is the only usable evidence.
      const url = header?.sourceMapURL || declared;
      let text: string | undefined;
      if (url?.startsWith("data:application/json")) {
        try {
          const comma = url.indexOf(",");
          if (comma !== -1) {
            const body = url.slice(comma + 1);
            text = /;base64/iu.test(url.slice(0, comma))
              ? Buffer.from(body, "base64").toString("utf-8")
              : decodeURIComponent(body);
          }
        } catch {
          /* Malformed embedded maps remain unassigned. */
        }
      } else if (url) {
        try {
          const target = new URL(url, header?.sourceURL || page.url());
          // Source maps are diagnostic evidence, never a reason to contact an
          // unrelated origin from a preview capture.
          if (target.origin === new URL(page.url()).origin)
            text = await page.evaluate(async (href) => {
              const response = await fetch(href);
              return response.ok ? response.text() : undefined;
            }, target.href);
        } catch {
          /* Missing or malformed maps remain unassigned. */
        }
      }
      let map: CssSourceMap | undefined;
      try {
        const parsed = text ? JSON.parse(text) : undefined;
        if (
          parsed &&
          parsed.version === 3 &&
          Array.isArray(parsed.sources) &&
          parsed.sources.every((source: unknown) => typeof source === "string") &&
          (parsed.sourceRoot === undefined || typeof parsed.sourceRoot === "string") &&
          typeof parsed.mappings === "string"
        )
          map = parsed;
      } catch {
        /* Source maps are optional evidence. */
      }
      sourceMaps.set(styleSheetId, map);
      return map;
    };
    const { root } = await session.send("DOM.getDocument");
    const { nodeIds } = await session.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: "body,body *",
    });
    const { nodeIds: interactiveNodeIds } = await session.send("DOM.querySelectorAll", {
      nodeId: root.nodeId,
      selector: "button,input,select,textarea,a[href],[role=button],[role=link]",
    });
    const interactiveNodes = new Set(interactiveNodeIds);
    // Resolve tokens in the active browser theme. A detached element only sees a
    // flattened default cascade and is misleading for dark or inherited themes.
    const normalized = await page.evaluate(
      ({ tokens, properties }) => {
        const el = document.createElement("span");
        el.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
        document.body.append(el);
        const result: Record<string, string[]> = {};
        for (const prop of Object.keys(properties)) {
          result[prop] = [];
          for (const [name] of Object.entries(tokens)) {
            const relevant = prop.includes("color")
              ? name.startsWith("--color-")
              : prop.includes("font") || prop.includes("line") || prop.includes("letter")
                ? /--(font|text|leading|tracking)/u.test(name)
                : prop.includes("radius")
                  ? name.includes("radius")
                  : prop.includes("shadow")
                    ? name.includes("shadow")
                    : /spacing|space|radius|border/u.test(name);
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
    const candidates: {
      nodeId: number;
      model: { width: number; height: number; content: number[] };
      region: "top" | "middle" | "bottom";
      interactive: boolean;
    }[] = [];
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
        candidates.filter((item) => item.region === region && item.interactive === interactive),
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
        ? uniqueIntrinsicSignature(generatedClassSignatures, signature.tag, signature.classes)
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
      const cv = Object.fromEntries(computed.computedStyle.map((p) => [p.name, p.value]));
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
            !(m.rule.media ?? []).some((media) => media.mediaList?.every((q) => !q.active)),
        );
        const inherited = /^(font-|line-height|letter-spacing|color$)/u.test(property)
          ? (matched.inherited ?? []).flatMap((i) =>
              (i.matchedCSSRules ?? []).filter((m) => m.rule.origin !== "user-agent"),
            )
          : [];
        const own = rules.flatMap((m) =>
          m.rule.style.cssProperties
            .filter((p) => p.name === property && !p.disabled && p.parsedOk !== false)
            .map((p) => ({ p, rule: m.rule, selector: matchedSelector(m) })),
        );
        const needsGapFallback =
          (property === "row-gap" || property === "column-gap") &&
          own.every((entry) => !entry.p.value.trim());
        const gapShorthands = needsGapFallback
          ? rules.flatMap((m) =>
              m.rule.style.cssProperties.filter(
                (p) => p.name === "gap" && !p.disabled && p.parsedOk !== false,
              ),
            )
          : [];
        const unsupportedGap = gapShorthands.some(
          (declaration) => declaration.value.trim() && !singleGapValue(declaration.value),
        );
        const gapFallback =
          needsGapFallback && !unsupportedGap
            ? rules.flatMap((m) =>
                m.rule.style.cssProperties
                  .filter(
                    (p) =>
                      p.name === "gap" &&
                      !p.disabled &&
                      p.parsedOk !== false &&
                      singleGapValue(p.value),
                  )
                  .map((p) => ({
                    p,
                    rule: m.rule,
                    selector: matchedSelector(m),
                  })),
              )
            : [];
        const ownEvidence = gapFallback.length ? gapFallback : own;
        const declarationEntries = inline.length
          ? inline.map((p) => ({ p, rule: undefined, selector: undefined }))
          : ownEvidence.length
            ? ownEvidence
            : inherited.flatMap((m) =>
                m.rule.style.cssProperties
                  .filter((p) => p.name === property && !p.disabled && p.parsedOk !== false)
                  .map((p) => ({
                    p,
                    rule: m.rule,
                    selector: matchedSelector(m),
                  })),
              );
        // Chrome can report the same matched rule twice. Collapse only entries
        // with the same owning rule location, selector, property, and value;
        // distinct cascade declarations remain deliberately ambiguous.
        const uniqueDeclarationEntries = [
          ...new Map(
            declarationEntries.map((entry) => [
              `${entry.rule?.styleSheetId ?? entry.rule?.style?.styleSheetId ?? "inline"}:${entry.rule?.style?.range?.startLine ?? -1}:${entry.rule?.style?.range?.startColumn ?? -1}:${entry.selector ?? ""}:${entry.p.name}:${entry.p.value}`,
              entry,
            ]),
          ).values(),
        ];
        const declarations = uniqueDeclarationEntries.map(({ p }) => p.value);
        const rule = uniqueDeclarationEntries[0]?.rule;
        const selector = uniqueDeclarationEntries[0]?.selector;
        const styleSheetId = rule?.styleSheetId ?? rule?.style?.styleSheetId;
        const path = sourcePath(styleSheetId ? headers.get(styleSheetId)?.sourceURL : undefined);
        const declaration = uniqueDeclarationEntries[0]?.p;
        const styleMap = await sourceMapFor(styleSheetId);
        // CDP omits CSSProperty.range in some backends. A rule range can only
        // stand in when it contains one usable declaration, so it still names
        // this property rather than an arbitrary sibling declaration.
        const mappingRange =
          declaration?.range ??
          ((rule?.style.cssProperties ?? []).filter(
            (entry) =>
              !entry.disabled && entry.parsedOk !== false && typeof entry.text === "string",
          ).length === 1
            ? rule?.style.range
            : undefined);
        const mapped = styleMap
          ? originalCssSource(
              styleMap,
              mappingRange?.startLine ?? -1,
              mappingRange?.startColumn ?? -1,
            )
          : undefined;
        const mappedPath = mapped?.path;
        const signatureGenerated =
          signatureOrigin.provenance === "generated" &&
          generatedSignatureSelector(generatedSignature, selector);
        const tokenOrigin = classTokenAttribution(
          generatedClassTokens,
          sharedClassTokens,
          selector,
        );
        // A shared component can assemble the same classes at runtime (including
        // through spreads), so a signature is reviewer evidence, never scored
        // declaration provenance. A direct stylesheet source is required.
        const generatedByPath = generatedSource(path, generatedSourcePaths);
        const generatedRule =
          !rule?.media?.length && !rule?.layers?.length
            ? generatedCssRule(
                generatedCssRules,
                sharedCssRules,
                selector,
                property,
                uniqueDeclarationEntries.length === 1
                  ? uniqueDeclarationEntries[0]?.p.value
                  : undefined,
                (rule?.style.cssProperties ?? []).filter(
                  (entry) =>
                    !entry.disabled && entry.parsedOk !== false && typeof entry.text === "string",
                ),
              )
            : undefined;
        const mappedSourceContent = mapped && styleMap?.sourcesContent?.[mapped.sourceIndex];
        const mappedFile = generatedCssSourceFiles.find(
          (file) =>
            generatedSource(mappedPath, [file.path]) && file.content === mappedSourceContent,
        );
        const mappedGenerated = Boolean(
          mappedFile &&
          generatedCssRules.filter(
            (candidate) =>
              candidate.source.path === mappedFile.path &&
              candidate.source.line === mapped?.line &&
              candidate.source.column === mapped?.column &&
              candidate.property === property &&
              candidate.value === declaration?.value,
          ).length === 1,
        );
        const mappedShared =
          uniqueDeclarationEntries.length === 1
            ? mappedSharedCssRule({
                map: styleMap,
                mapped,
                property,
                value: declaration?.value,
                sharedCssRules,
                sharedCssSourceFiles,
              })
            : undefined;
        const generated = generatedByPath || Boolean(generatedRule) || mappedGenerated;
        const inheritedDeclaration =
          !inline.length && !own.length && uniqueDeclarationEntries.length > 0;
        let classification: string = classifyStyle(
          declarations,
          cv[property] ?? "",
          normalized[property] ?? [],
        );
        if (unsupportedGap) classification = "unknown";
        if (
          classification === "token-reference" &&
          declarations.some((v) =>
            [...v.matchAll(/var\((--[\w-]+)/gu)].some((m) => !(m[1] in tokens)),
          )
        )
          classification = "unassessed";
        if (classification === "token-reference") classification = "semantic-token-reference";
        if (generated && classification === "unmatched-literal")
          classification = "generated-override";
        if (
          !generated &&
          (arrustedSharedSource(path) || Boolean(mappedShared)) &&
          classification !== "semantic-token-reference" &&
          classification !== "matching-literal" &&
          classification !== "structural"
        )
          classification = "inherited-shared";
        if (classification === "unassessed" || classification === "unmatched-literal")
          classification = "unknown";
        // Structural layout values are not adherence evidence, so exclude them
        // entirely rather than allowing downstream global scores to count them.
        if (classification === "structural") continue;
        const provenance: Observation["provenance"] = generated
          ? "generated"
          : arrustedSharedSource(path) || mappedShared
            ? "shared"
            : "unknown";
        const quad = model.content;
        const region = {
          x: quad[0] ?? 0,
          y: quad[1] ?? 0,
          width: model.width,
          height: model.height,
        };
        const cssSource = generatedRule
          ? generatedRule.source
          : (mappedShared?.source ??
            mapped ??
            (path
              ? {
                  path,
                  line: (rule?.style?.range?.startLine ?? 0) + 1,
                  column: (rule?.style?.range?.startColumn ?? 0) + 1,
                }
              : undefined));
        const originCandidate =
          signatureGenerated && signatureOrigin.source
            ? {
                provenance: "generated" as const,
                reason:
                  "Exact rendered intrinsic tag/class signature and simple matched class selector match generated source; shared runtime assembly remains possible.",
                source: signatureOrigin.source,
              }
            : tokenOrigin.provenance !== "unknown" && tokenOrigin.source
              ? {
                  provenance: tokenOrigin.provenance,
                  reason:
                    "Exact escaped Tailwind utility token occurs once in static source; it is reviewer evidence only, not declaration provenance.",
                  source: tokenOrigin.source,
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
            provenance === "generated" && classification === "semantic-token-reference"
              ? "conforming"
              : provenance === "generated" &&
                  (classification === "matching-literal" || classification === "generated-override")
                ? "nonconforming"
                : "unassessed",
          provenance,
          evidence: "browser",
          summary: originCandidate
            ? `${property}: ${classification}; ${originCandidate.provenance} origin candidate requires review.`
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
          ].map((key) => [key, items.filter((o) => o.classification === key).length]),
        );
        const assessed = items.filter((item) => item.verdict !== "unassessed").length;
        return [
          category,
          {
            counts,
            assessed,
            total: items.length,
            coveragePercent: items.length ? Math.round((assessed / items.length) * 100) : null,
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
              eligible: candidates.filter((item) => item.region === region).length,
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
        "A shared bundle is never treated as positive generated adherence. Anonymous rules require a unique exact generated selector/property/value and complete matched-rule declaration set; conditional or ambiguous source rules remain unknown.",
        "Intrinsic tag/class matches are reviewer-facing generated-origin candidates only. Shared components can assemble identical classes dynamically, so they remain unknown and unassessed without direct stylesheet provenance.",
        ...(generatedCssSourceFiles.length
          ? []
          : [
              "No generated CSS source files were supplied; compiled stylesheet source maps cannot establish generated declaration provenance.",
            ]),
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
  generatedClassTokens?: ClassTokenEvidence[];
  sharedClassTokens?: ClassTokenEvidence[];
  generatedCssRules?: CssRuleEvidence[];
  sharedCssRules?: CssRuleEvidence[];
  generatedCssSourceFiles?: { path: string; content: string }[];
  sharedCssSourceFiles?: CssSourceFile[];
  additionalDesktopSize?: DesktopSize;
}) {
  const browser = await chromium.launch();
  const captures = [];
  try {
    for (const viewport of captureViewports(input.additionalDesktopSize)) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 1,
      });
      // tsx preserves local function names using this helper when serializing
      // page.evaluate callbacks. Install it only in this disposable QA context.
      await context.addInitScript("globalThis.__name = (value) => value;");
      const page = await context.newPage();
      // Never attach project OIDC, cookies, or provider headers to preview requests.
      const response = await page.goto(input.url, { waitUntil: "load" });
      if (response && !response.ok()) throw new Error(`Preview returned HTTP ${response.status()}`);
      await page.evaluate(() => document.fonts.ready);
      for (let index = 0; index <= input.scenarios.length; index += 1) {
        const scenario = index === 0 ? undefined : input.scenarios[index - 1];
        let interaction: { status: string; expectedText?: string } = {
          status: "not-run",
        };
        if (scenario) {
          const refreshed = await page.reload({ waitUntil: "load" });
          if (refreshed && !refreshed.ok())
            throw new Error(`Preview returned HTTP ${refreshed.status()}`);
          try {
            for (const step of scenario.steps) {
              const locator = step.selector
                ? page.locator(step.selector)
                : page.getByRole(step.role as Parameters<Page["getByRole"]>[0], {
                    name: step.name,
                    exact: true,
                  });
              if (step.action === "click") await locator.click();
              else if (step.action === "fill") await locator.fill(step.value ?? "");
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
                input.generatedCssRules,
                input.sharedCssRules,
                input.generatedCssSourceFiles,
                input.sharedCssSourceFiles,
                input.generatedClassTokens,
                input.sharedClassTokens,
              )
            : undefined;
        if (styles)
          for (const observation of styles.observations) {
            observation.capture = name;
            observation.id = `${name}-${observation.id}`;
          }
        const path = join(input.output, `${name}.png`);
        await settleFiniteMotion(page);
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
