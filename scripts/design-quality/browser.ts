import { chromium } from "playwright";
import type { Page } from "playwright";
import axe from "axe-core";
import nodePath from "node:path";
import { z } from "zod";
import type { Observation } from "./evidence";
import {
  generatedSignatureSelector,
  signatureAttribution,
  uniqueIntrinsicSignature,
} from "./class-evidence";
import type { ClassTokenEvidence, IntrinsicClassSignature } from "./class-evidence";
import { generatedCssRule } from "./css-evidence";
import type { CssRuleEvidence } from "./css-evidence";
import { originalCssSource } from "./css-source-map";
import type { CssSourceMap } from "./css-source-map";
import { runSequentially } from "../../lib/async-sequential";

export const viewports = [
  { height: 900, name: "desktop", width: 1440 },
  { height: 1080, name: "desktop-wide", width: 1920 },
  { height: 768, name: "desktop-window", width: 1024 },
];

export interface DesktopSize {
  width: number;
  height: number;
}

const sourceMapPrefix = "data:application/json";
const tokenReferenceLabel = "semantic-token-reference";
const generatedOverrideLabel = "generated-override";
const inheritedSharedLabel = "inherited-shared";
const structuralLabel = "structural";
const unassessedLabel = "unassessed";
const matchingLiteralLabel = "matching-literal";
const unmatchedLiteralLabel = "unmatched-literal";
const semanticTokenReference = tokenReferenceLabel;
const generatedOverride = generatedOverrideLabel;
const inheritedShared = inheritedSharedLabel;
const structuralClassification = structuralLabel;
const tokenClassification = "token-reference";
const unassessedClassification = unassessedLabel;
const matchingLiteralClassification = matchingLiteralLabel;
const unmatchedLiteralClassification = unmatchedLiteralLabel;
const structuralValuePattern =
  /^(?<value>0(?:px|rem|em)?|auto|normal|none|inherit|initial|transparent)$/u;
const structuralFractionPattern = /%|\d(?:\.\d+)?fr\b/u;

/** Parses an opt-in desktop window size without imposing a width policy. */
export function parseAdditionalDesktopSize(value: string): DesktopSize {
  const match = /^(?<width>[1-9]\d*)x(?<height>[1-9]\d*)$/u.exec(value);
  if (!match) {
    throw new TypeError("Use WIDTHxHEIGHT with positive integer dimensions");
  }
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
    throw new TypeError("Desktop dimensions must be safe integers");
  }
  return { height, width };
}

export function captureViewports(additionalDesktopSize?: DesktopSize) {
  if (additionalDesktopSize === undefined) {
    return viewports;
  }
  return [
    ...viewports,
    {
      name: `desktop-custom-${additionalDesktopSize.width}x${additionalDesktopSize.height}`,
      ...additionalDesktopSize,
    },
  ];
}
const hasScenarioSelector = (step: { selector?: string }) => (step.selector?.length ?? 0) > 0;
const hasScenarioRole = (step: { role?: string; name?: string }) =>
  (step.role?.length ?? 0) > 0 && (step.name?.length ?? 0) > 0;
export const scenariosSchema = z.array(
  z.object({
    expect: z.object({ text: z.string().optional() }).optional(),
    name: z.string().min(1),
    steps: z.array(
      z
        .object({
          action: z.enum(["click", "fill", "select"]),
          name: z.string().optional(),
          role: z.string().optional(),
          selector: z.string().optional(),
          value: z.string().optional(),
        })
        .refine(
          (s) => hasScenarioSelector(s) || hasScenarioRole(s),
          "Select a role/name or selector",
        ),
    ),
  }),
);
export type Scenario = z.infer<typeof scenariosSchema>[number];
export type Category = "color" | "typography" | "spacing" | "radius" | "border" | "shadow";
export const properties = {
  "background-color": "color",
  "border-top-color": "border",
  "border-top-left-radius": "radius",
  "border-top-width": "border",
  "box-shadow": "shadow",
  color: "color",
  "column-gap": "spacing",
  "font-family": "typography",
  "font-size": "typography",
  "font-weight": "typography",
  "letter-spacing": "typography",
  "line-height": "typography",
  "margin-bottom": "spacing",
  "margin-top": "spacing",
  "padding-bottom": "spacing",
  "padding-left": "spacing",
  "padding-right": "spacing",
  "padding-top": "spacing",
  "row-gap": "spacing",
} satisfies Record<string, Category>;
const classifyStyleValues = (values: string[], computed: string, tokenValues: string[]) => {
  const unique = [...new Set(values)];
  if (unique.length !== 1) {
    return unassessedClassification;
  }
  const [value] = unique;
  if (/var\(--/u.test(value)) {
    return tokenClassification;
  }
  if (structuralValuePattern.test(value) || structuralFractionPattern.test(value)) {
    return structuralClassification;
  }
  return tokenValues.includes(computed)
    ? matchingLiteralClassification
    : unmatchedLiteralClassification;
};
export function classifyStyle(values: string[], computed: string, tokenValues: string[]) {
  return classifyStyleValues(values, computed, tokenValues);
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

const domClassSignature = (node: { nodeName?: string; attributes?: string[] }) => {
  const index = node.attributes?.indexOf("class") ?? -1;
  const value = index >= 0 ? node.attributes?.[index + 1] : undefined;
  if ((value?.length ?? 0) === 0 || (node.nodeName?.length ?? 0) === 0) {
    return;
  }
  return {
    classes: [...new Set(value.split(/\s+/u).filter(Boolean))].toSorted(),
    tag: node.nodeName.toLowerCase(),
  };
};

function matchedSelector(match: {
  matchingSelectors?: number[];
  rule: { selectorList?: { selectors?: { text?: string }[] } };
}): string | undefined {
  const selectors = match.rule.selectorList?.selectors;
  if (selectors === undefined || selectors.length === 0) {
    return undefined;
  }
  const indexes = match.matchingSelectors;
  if (indexes?.length === 1) {
    return selectors[indexes[0]]?.text;
  }
  return selectors.length === 1 ? selectors[0]?.text : undefined;
}

/**
 * CDP expands `gap` into empty row/column longhands. A shorthand can support
 * either axis only when it contains exactly one top-level CSS value; two-value
 * gaps deliberately remain ambiguous rather than being assigned to both axes.
 */
function singleGapValue(value: string): string | undefined {
  const candidate = value.trim();
  if (candidate.length === 0) {
    return undefined;
  }
  let depth = 0;
  for (const character of candidate) {
    if (character === "(") {
      depth += 1;
    } else if (character === ")") {
      depth -= 1;
      if (depth < 0) {
        return undefined;
      }
    } else if (depth === 0 && /\s/u.test(character)) {
      return undefined;
    }
  }
  return depth === 0 ? candidate : undefined;
}

export const sourcePath = (value: string | undefined): string | undefined => {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "file:" ? decodeURIComponent(url.pathname) : url.pathname;
  } catch {
    return value.split(/[?#]/u, 1)[0];
  }
};

export const generatedSource = (path: string | undefined, generated: string[]): boolean => {
  if (path === undefined || path.length === 0) {
    return false;
  }
  const clean = path.replaceAll("\\", "/");
  return generated.some((candidate) => {
    const expected = sourcePath(candidate)?.replaceAll("\\", "/");
    return (
      expected !== undefined &&
      (clean === expected || clean.endsWith(`/${expected.replace(/^\/+/u, "")}`))
    );
  });
};

// A stylesheet URL alone is not provenance. The only shared source family we
// recognise in browser evidence is the checked-in Arrusted design-system tree.
export const arrustedSharedSource = (path: string | undefined) =>
  Boolean(path?.replaceAll("\\", "/").match(/(?:^|\/)packages\/design-systems(?:\/|$)/u));

interface CssSourceFile {
  path: string;
  content: string;
}

const sourceMapSchema = z.object({
  mappings: z.string(),
  sourceRoot: z.string().optional(),
  sources: z.array(z.string()),
  sourcesContent: z.array(z.string().nullable()).optional(),
  version: z.literal(3),
});
type ParsedSourceMap = z.infer<typeof sourceMapSchema>;
const parseCssSourceMap = (input: ParsedSourceMap): CssSourceMap => input;

const roleSchema = z.enum([
  "alert",
  "alertdialog",
  "application",
  "article",
  "banner",
  "blockquote",
  "button",
  "caption",
  "cell",
  "checkbox",
  "code",
  "columnheader",
  "combobox",
  "complementary",
  "contentinfo",
  "definition",
  "deletion",
  "dialog",
  "directory",
  "document",
  "emphasis",
  "feed",
  "figure",
  "form",
  "generic",
  "grid",
  "gridcell",
  "group",
  "heading",
  "img",
  "insertion",
  "link",
  "list",
  "listbox",
  "listitem",
  "log",
  "main",
  "marquee",
  "math",
  "menu",
  "menubar",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "meter",
  "navigation",
  "none",
  "note",
  "option",
  "presentation",
  " progress",
  " radio",
  "radiogroup",
  "region",
  " button",
  "row",
  "rowgroup",
  "rowheader",
  "scrollbar",
  "search",
  "searchbox",
  "separator",
  "slider",
  " spinbutton",
  "status",
  "strong",
  "subscript",
  "superscript",
  "switch",
  "tab",
  "table",
  "tablist",
  "tabpanel",
  "term",
  " textbox",
  "timer",
  "toolbar",
  "tooltip",
  "tree",
  "treegrid",
  "treeitem",
]);
const parseRole = (input: string) => roleSchema.parse(input);

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
}): CssRuleEvidence | undefined {
  const { map, mapped, property, value, sharedCssRules, sharedCssSourceFiles } = input;
  if (!map || !mapped || value === undefined) {
    return undefined;
  }
  const sourceContent = map.sourcesContent?.[mapped.sourceIndex];
  if (sourceContent === undefined || sourceContent === null) {
    return undefined;
  }
  const files = sharedCssSourceFiles.filter(
    (file) =>
      arrustedSharedSource(file.path) &&
      generatedSource(mapped.path, [file.path]) &&
      file.content === sourceContent,
  );
  if (files.length !== 1) {
    return undefined;
  }
  const [file] = files;
  if (file === undefined) {
    return undefined;
  }
  const declarations = sharedCssRules.filter((candidate) => {
    if (candidate.source.path !== file.path || candidate.source.line !== mapped.line) {
      return false;
    }
    const samePosition = candidate.source.column === mapped.column;
    const sameDeclaration = candidate.property === property && candidate.value === value;
    return samePosition && sameDeclaration;
  });
  return declarations.length === 1 ? declarations[0] : undefined;
}

/** Wait for currently active finite CSS motion before sampling visual evidence. */
export async function settleFiniteMotion(page: Page) {
  await page.evaluate(async () => {
    // Let hydration/class updates start their CSS transitions before taking the
    // animation snapshot. A second frame is enough without adding a timer gate.
    const { promise, resolve } = Promise.withResolvers<null>();
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve(null);
      });
    });
    await promise;
    const finite = document.getAnimations().filter((motion) => {
      if (motion.playState !== "running" && !motion.pending) {
        return false;
      }
      const timing = motion.effect?.getComputedTiming();
      const iterations = timing?.iterations ?? 1;
      return Number.isFinite(iterations) && Number.isFinite(timing?.duration);
    });
    await Promise.all(
      finite.map(async (motion) => {
        try {
          await motion.finished;
        } catch {
          // A canceled finite transition is settled for capture purposes.
        }
      }),
    );
  });
}

export async function measurePage(page: Page) {
  await settleFiniteMotion(page);
  await page.addScriptTag({ content: axe.source });
  return await page.evaluate(async () => {
    // Keep DOM measurement helpers together with browser traversal.
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return {
        height: r.height,
        width: r.width,
        x: r.x + scrollX,
        y: r.y + scrollY,
      };
    };
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const label = (el: Element) =>
      (el.getAttribute("aria-label") ?? el.textContent ?? el.tagName).trim().slice(0, 160);
    const findings: {
      kind: string;
      description: string;
      region: ReturnType<typeof rect>;
      reviewRequired: boolean;
    }[] = [];
    const collectScrollAxes = (el: Element) => {
      if (!visible(el)) {
        return [];
      }
      const style = getComputedStyle(el);
      const axes: ("x" | "y")[] = [];
      if (el.scrollWidth > el.clientWidth + 2 && /auto|scroll/u.test(style.overflowX)) {
        axes.push("x");
      }
      if (el.scrollHeight > el.clientHeight + 2 && /auto|scroll/u.test(style.overflowY)) {
        axes.push("y");
      }
      return axes.map((axis) => ({
        axis,
        clientHeight: el.clientHeight,
        clientWidth: el.clientWidth,
        el,
        scrollHeight: el.scrollHeight,
        scrollWidth: el.scrollWidth,
      }));
    };
    const scrolling = [...document.querySelectorAll("*")].flatMap(collectScrollAxes);
    if (document.documentElement.scrollWidth > innerWidth + 2) {
      findings.push({
        description:
          "Page is wider than the viewport; review whether horizontal scrolling is intended.",
        kind: "document-overflow",
        region: rect(document.documentElement),
        reviewRequired: true,
      });
    }
    const controls = [
      ...document.querySelectorAll("button,input,select,textarea,a[href],[role=button]"),
    ].filter(visible);
    const inspectClipping = (el: Element) => {
      let parent = el.parentElement;
      while (parent !== null) {
        const s = getComputedStyle(parent);
        const a = el.getBoundingClientRect();
        const b = parent.getBoundingClientRect();
        if (/hidden|clip/u.test(s.overflowX) && (a.left < b.left - 2 || a.right > b.right + 2)) {
          findings.push({
            description: `${label(el)} extends beyond a clipped ancestor.`,
            kind: "possible-clipping",
            region: rect(el),
            reviewRequired: true,
          });
          break;
        }
        parent = parent.parentElement;
      }
    };
    for (const control of controls) {
      inspectClipping(control);
    }
    const inspectTable = (table: Element) => {
      const headers = [...table.querySelectorAll("th,[role=columnheader]")].filter(visible);
      const row = [...table.querySelectorAll("tr,[role=row]")].find((r) =>
        r.querySelector("td,[role=cell],[role=gridcell]"),
      );
      const cells = row
        ? [...row.querySelectorAll("td,[role=cell],[role=gridcell]")].filter(visible)
        : [];
      if (headers.length === cells.length) {
        for (const [i, h] of headers.entries()) {
          const cell = cells[i];
          if (
            cell !== undefined &&
            Math.abs(h.getBoundingClientRect().left - cell.getBoundingClientRect().left) > 4
          ) {
            findings.push({
              description: `Column ${label(h)} and its first cell have different left edges.`,
              kind: "possible-column-misalignment",
              region: rect(h),
              reviewRequired: true,
            });
          }
        }
      }
    };
    for (const table of document.querySelectorAll("table,[role=table],[role=grid]")) {
      inspectTable(table);
    }
    // Only sibling interactive targets: generic rectangle overlap is too noisy.
    const boundedControls = controls.slice(0, 150);
    const hasOverlap = (first: Element, second: Element) => {
      void controls.length;
      if (
        first.parentElement !== second.parentElement ||
        first.contains(second) ||
        second.contains(first)
      ) {
        return false;
      }
      const firstRect = first.getBoundingClientRect();
      const secondRect = second.getBoundingClientRect();
      const width =
        Math.min(firstRect.right, secondRect.right) - Math.max(firstRect.left, secondRect.left);
      const height =
        Math.min(firstRect.bottom, secondRect.bottom) - Math.max(firstRect.top, secondRect.top);
      return width > 4 && height > 4;
    };
    for (let i = 0; i < boundedControls.length; i += 1) {
      for (let j = i + 1; j < boundedControls.length; j += 1) {
        const a = boundedControls[i];
        const b = boundedControls[j];
        if (a !== undefined && b !== undefined && hasOverlap(a, b)) {
          findings.push({
            description: `Interactive targets overlap: ${label(a)} / ${label(b)}.`,
            kind: "possible-overlap",
            region: rect(a),
            reviewRequired: true,
          });
        }
      }
    }
    const axeResult = await axe.run();
    const result = {
      incomplete: axeResult.incomplete,
      violations: axeResult.violations.map((violation) => ({
        help: violation.help,
        id: violation.id,
        impact: violation.impact ?? "unknown",
        nodes: violation.nodes.map((node) => ({
          failureSummary: node.failureSummary ?? "",
          target: node.target.map(String),
        })),
      })),
    };
    return {
      accessibility: {
        manualReviewCount: result.incomplete.length,
        violations: result.violations.map((v) => ({
          help: v.help,
          id: v.id,
          impact: v.impact,
          nodes: v.nodes.map((n) => ({
            summary: n.failureSummary,
            target: n.target,
          })),
        })),
      },
      controls: controls.map((el) => ({
        label: label(el),
        region: rect(el),
        role: el.getAttribute("role") ?? el.tagName.toLowerCase(),
      })),
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      findings,
      height: innerHeight,
      // Diagnostics only: an intentional scroll region is not an automatic
      // pass/fail conclusion about the surrounding layout.
      intentionalScrollContainers: scrolling.map((scrollContainer) => ({
        axis: scrollContainer.axis,
        clientHeight: scrollContainer.clientHeight,
        clientWidth: scrollContainer.clientWidth,
        label: label(scrollContainer.el),
        region: rect(scrollContainer.el),
        scrollHeight: scrollContainer.scrollHeight,
        scrollWidth: scrollContainer.scrollWidth,
      })),
      title: document.title,
      width: innerWidth,
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
  _generatedClassTokens: ClassTokenEvidence[] = [],
  _sharedClassTokens?: ClassTokenEvidence[],
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
        header: { styleSheetId: string; sourceURL?: string; sourceMapURL?: string };
      }) => {
        headers.set(header.styleSheetId, header);
      },
    );
    await session.send("DOM.enable");
    await session.send("CSS.enable");
    const sourceMaps = new Map<string, CssSourceMap | undefined>();
    const sourceMapFor = async (styleSheetId: string | undefined) => {
      if (styleSheetId === undefined) {
        return;
      }
      if (sourceMaps.has(styleSheetId)) {
        return sourceMaps.get(styleSheetId);
      }
      const header = headers.get(styleSheetId);
      let css = "";
      try {
        ({ text: css } = await session.send("CSS.getStyleSheetText", { styleSheetId }));
      } catch {
        css = "";
      }
      const declared = /\/[*]#\s*sourceMappingURL=(?<url>[^\s*]+)\s*[*]\//u.exec(css)?.[1];
      // CDP may report optional URLs as empty strings. In that case the
      // stylesheet's sourceMappingURL comment is the only usable evidence.
      const url = header?.sourceMapURL ?? declared;
      let text: string | undefined;
      if (url?.startsWith(sourceMapPrefix) === true) {
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
      } else if (url !== undefined && url.length > 0) {
        try {
          const target = new URL(url, header?.sourceURL ?? page.url());
          // Source maps are diagnostic evidence, never a reason to contact an
          // unrelated origin from a preview capture.
          if (target.origin === new URL(page.url()).origin) {
            text = await page.evaluate(async (href) => {
              const response = await fetch(href);
              return response.ok ? await response.text() : undefined;
            }, target.href);
          }
        } catch {
          /* Missing or malformed maps remain unassigned. */
        }
      }
      let map: CssSourceMap | undefined;
      try {
        map =
          text === undefined || text.length === 0
            ? undefined
            : parseCssSourceMap(sourceMapSchema.parse(JSON.parse(text)));
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
      ({ tokens: tokenValues, properties: styleProperties }) => {
        const el = document.createElement("span");
        el.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
        document.body.append(el);
        const result: Record<string, string[]> = {};
        for (const prop of Object.keys(styleProperties)) {
          result[prop] = [];
          for (const [name] of Object.entries(tokenValues)) {
            let relevant: boolean;
            if (prop.includes("color")) {
              relevant = name.startsWith("--color-");
            } else if (prop.includes("font") || prop.includes("line") || prop.includes("letter")) {
              relevant = /--(?<category>font|text|leading|tracking)/u.test(name);
            } else if (prop.includes("radius")) {
              relevant = name.includes("radius");
            } else if (prop.includes("shadow")) {
              relevant = name.includes("shadow");
            } else {
              relevant = /spacing|space|radius|border/u.test(name);
            }
            if (!relevant) {
              continue;
            }
            el.style.removeProperty(prop);
            el.style.setProperty(prop, `var(${name})`);
            if (el.style.getPropertyValue(prop)) {
              result[prop].push(getComputedStyle(el).getPropertyValue(prop));
            }
          }
        }
        el.remove();
        return result;
      },
      { properties, tokens },
    );
    // CSS.enable normally emits existing headers, but source location is optional
    // in CDP. Missing headers deliberately remain unknown.
    const candidates: {
      nodeId: number;
      model: { width: number; height: number; content: number[] };
      region: "top" | "middle" | "bottom";
      interactive: boolean;
    }[] = [];
    const boxModels = await Promise.all(
      nodeIds.map(async (nodeId) => {
        try {
          return await session.send("DOM.getBoxModel", { nodeId });
        } catch {
          return null;
        }
      }),
    );
    for (const [index, nodeId] of nodeIds.entries()) {
      const result = boxModels[index];
      const model = result?.model;
      if (model !== undefined && model.width > 0 && model.height > 0) {
        const y = model.content[1] ?? 0;
        let region: "top" | "middle" | "bottom" = "bottom";
        if (y < 300) {
          region = "top";
        } else if (y < 1000) {
          region = "middle";
        }
        candidates.push({ interactive: interactiveNodes.has(nodeId), model, nodeId, region });
      }
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
    for (const interactiveBucket of buckets.filter((bucket) => bucket[0]?.interactive)) {
      const candidate = interactiveBucket.shift();
      if (candidate) {
        selected.push(candidate);
      }
    }
    while (selected.length < 120) {
      let added = false;
      for (const bucket of buckets) {
        const candidate = selected.length < 120 ? bucket.shift() : undefined;
        if (candidate !== undefined) {
          selected.push(candidate);
          added = true;
        }
      }
      if (!added) {
        break;
      }
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
      if (cv.display === "none" || cv.visibility === "hidden") {
        continue;
      }
      const matched = await session.send("CSS.getMatchedStylesForNode", {
        nodeId,
      });
      for (const [property, category] of Object.entries(properties)) {
        const isUsable = (p: { name: string; disabled?: boolean; parsedOk?: boolean }) =>
          p.name === property && p.disabled !== true && p.parsedOk !== false;
        const inline = (matched.inlineStyle?.cssProperties ?? []).filter(isUsable);
        const rules = (matched.matchedCSSRules ?? []).filter(
          (m) =>
            m.rule.origin !== "user-agent" &&
            !(m.rule.media ?? []).some(
              (media) => media.mediaList?.every((q) => !q.active) ?? false,
            ),
        );
        const inherited = /^(?<property>font-|line-height|letter-spacing|color$)/u.test(property)
          ? (matched.inherited ?? []).flatMap((i) =>
              (i.matchedCSSRules ?? []).filter((m) => m.rule.origin !== "user-agent"),
            )
          : [];
        const own = rules.flatMap((m) =>
          m.rule.style.cssProperties
            .filter(isUsable)
            .map((p) => ({ p, rule: m.rule, selector: matchedSelector(m) })),
        );
        const needsGapFallback =
          (property === "row-gap" || property === "column-gap") &&
          own.every((entry) => !entry.p.value.trim());
        const gapShorthands = needsGapFallback
          ? rules.flatMap((m) =>
              m.rule.style.cssProperties.filter(
                (p) => p.name === "gap" && p.disabled !== true && p.parsedOk !== false,
              ),
            )
          : [];
        const unsupportedGap = gapShorthands.some(
          (declaration) =>
            declaration.value.trim().length > 0 && singleGapValue(declaration.value) === undefined,
        );
        const gapFallback =
          needsGapFallback && !unsupportedGap
            ? rules.flatMap((m) =>
                m.rule.style.cssProperties
                  .filter(
                    (p) =>
                      p.name === "gap" &&
                      p.disabled !== true &&
                      p.parsedOk !== false &&
                      singleGapValue(p.value) !== undefined,
                  )
                  .map((p) => ({
                    p,
                    rule: m.rule,
                    selector: matchedSelector(m),
                  })),
              )
            : [];
        const ownEvidence = gapFallback.length ? gapFallback : own;
        let declarationEntries = inherited.flatMap((m) =>
          m.rule.style.cssProperties
            .filter((p) => p.name === property && p.disabled !== true && p.parsedOk !== false)
            .map((p) => ({
              p,
              rule: m.rule,
              selector: matchedSelector(m),
            })),
        );
        if (ownEvidence.length) {
          declarationEntries = ownEvidence;
        }
        if (inline.length > 0) {
          declarationEntries = inline.map((p) => ({ p, rule: null, selector: null }));
        }
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
        const path = sourcePath(
          styleSheetId === undefined ? undefined : headers.get(styleSheetId)?.sourceURL,
        );
        const declaration = uniqueDeclarationEntries[0]?.p;
        const styleMap = await sourceMapFor(styleSheetId);
        // CDP omits CSSProperty.range in some backends. A rule range can only
        // stand in when it contains one usable declaration, so it still names
        // this property rather than an arbitrary sibling declaration.
        const mappingRange =
          declaration?.range ??
          ((rule?.style.cssProperties ?? []).filter(
            (entry) =>
              entry.disabled !== true && entry.parsedOk !== false && entry.text !== undefined,
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
        // A shared component can assemble the same classes at runtime (including
        // through spreads), so a signature is reviewer evidence, never scored
        // declaration provenance. A direct stylesheet source is required.
        const generatedByPath = generatedSource(path, generatedSourcePaths);
        const generatedRule =
          rule?.media?.length === 0 && rule.layers?.length === 0
            ? generatedCssRule(
                generatedCssRules,
                sharedCssRules,
                selector,
                property,
                uniqueDeclarationEntries[0]?.p.value,
                (rule?.style.cssProperties ?? []).filter(
                  (entry) =>
                    entry.disabled !== true && entry.parsedOk !== false && entry.text !== undefined,
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
        let mappedShared: ReturnType<typeof mappedSharedCssRule>;
        if (uniqueDeclarationEntries.length === 1) {
          mappedShared = mappedSharedCssRule({
            map: styleMap,
            mapped,
            property,
            sharedCssRules,
            sharedCssSourceFiles,
            value: declaration?.value,
          });
        }
        const generated = generatedByPath || generatedRule !== undefined || mappedGenerated;
        const inheritedDeclaration =
          !inline.length && !own.length && uniqueDeclarationEntries.length > 0;
        let classification: string = classifyStyle(
          declarations,
          cv[property] ?? "",
          normalized[property] ?? [],
        );
        if (unsupportedGap) {
          classification = "unknown";
        }
        if (
          classification === "token-reference" &&
          declarations.some((v) =>
            [...v.matchAll(/var\((?<name>--[\w-]+)/gu)].some((m) => !(m[1] in tokens)),
          )
        ) {
          classification = "unassessed";
        }
        if (classification === "token-reference") {
          classification = semanticTokenReference;
        }
        if (generated && classification === "unmatched-literal") {
          classification = generatedOverride;
        }
        if (
          !generated &&
          (arrustedSharedSource(path) || mappedShared !== undefined) &&
          classification !== semanticTokenReference &&
          classification !== "matching-literal" &&
          classification !== "structural"
        ) {
          classification = inheritedShared;
        }
        if (classification === "unassessed" || classification === "unmatched-literal") {
          classification = "unknown";
        }
        // Structural layout values are not adherence evidence, so exclude them
        // entirely rather than allowing downstream global scores to count them.
        if (classification === "structural") {
          continue;
        }
        let provenance: Observation["provenance"] = "unknown";
        if (arrustedSharedSource(path) || mappedShared !== undefined) {
          provenance = "shared";
        }
        if (generated) {
          provenance = "generated";
        }
        const quad = model.content;
        const region = {
          height: model.height,
          width: model.width,
          x: quad[0] ?? 0,
          y: quad[1] ?? 0,
        };
        const cssSource = generatedRule
          ? generatedRule.source
          : (mappedShared?.source ??
            mapped ??
            (path === undefined
              ? undefined
              : {
                  column: (rule?.style?.range?.startColumn ?? 0) + 1,
                  line: (rule?.style?.range?.startLine ?? 0) + 1,
                  path,
                }));
        let originCandidate: BrowserStyleObservation["originCandidate"];
        if (signatureGenerated && signatureOrigin.source) {
          originCandidate = {
            provenance: "generated" as const,
            reason:
              "Exact rendered intrinsic tag/class signature and simple matched class selector match generated source; shared runtime assembly remains possible.",
            source: signatureOrigin.source,
          };
        }
        const source = cssSource;
        let origin: BrowserStyleObservation["origin"] = "unknown";
        if (inline.length) {
          origin = "inline";
        }
        if (provenance === "shared") {
          origin = "shared-rule";
        }
        if (provenance === "shared" && inheritedDeclaration) {
          origin = "inherited-shared";
        }
        if (generated) {
          origin = "generated-rule";
        }
        let verdict: BrowserStyleObservation["verdict"] = "unassessed";
        if (
          provenance === "generated" &&
          (classification === "matching-literal" || classification === "generated-override")
        ) {
          verdict = "nonconforming";
        }
        if (provenance === "generated" && classification === "semantic-token-reference") {
          verdict = "conforming";
        }
        observations.push({
          category,
          classification,
          computed: cv[property] ?? "",
          cssSource,
          declarations: [...new Set(declarations)],
          dimension: "styling",
          evidence: "browser",
          id: `style-${nodeId}-${property}`,
          node: `node-${nodeId}`,
          origin,
          originCandidate,
          property,
          provenance,
          region,
          selector,
          source,
          summary: originCandidate
            ? `${property}: ${classification}; ${originCandidate.provenance} origin candidate requires review.`
            : `${property}: ${classification}`,
          verdict,
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
            assessed,
            counts,
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
            total: items.length,
          },
        ];
      }),
    );
    return {
      categories,
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
      observations,
      sampledElements: selected.length,
      sampling: {
        coveragePercent: candidates.length
          ? Math.round((selected.length / candidates.length) * 100)
          : null,
        eligible: candidates.length,
        regions: Object.fromEntries(
          (["top", "middle", "bottom"] as const).map((region) => [
            region,
            {
              eligible: candidates.filter((item) => item.region === region).length,
              sampled: selected.filter((item) => item.region === region).length,
            },
          ]),
        ),
        sampled: selected.length,
      },
      totalDomElements: nodeIds.length,
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
  /** For evaluator-owned local HTTPS fixtures with self-signed certificates. */
  ignoreHTTPSErrors?: boolean;
  /** Evaluator-owned state preparation; exceptions stop capture without fallback. */
  preparePage?: (page: Page) => Promise<void>;
}) {
  const browser = await chromium.launch();
  const captures: {
    height: number;
    interaction: { status: string; expectedText?: string | null };
    measurements: Awaited<ReturnType<typeof measurePage>>;
    name: string;
    path: string;
    state: string;
    styles: Awaited<ReturnType<typeof measureStyles>> | undefined;
    width: number;
  }[] = [];
  try {
    await runSequentially(captureViewports(input.additionalDesktopSize), async (viewport) => {
      const context = await browser.newContext({
        baseURL: input.url,
        deviceScaleFactor: 1,
        ignoreHTTPSErrors: input.ignoreHTTPSErrors ?? false,
        viewport: { height: viewport.height, width: viewport.width },
      });
      // tsx preserves local function names using this helper when serializing
      // page.evaluate callbacks. Install it only in this disposable QA context.
      await context.addInitScript("globalThis.__name = (value) => value;");
      const page = await context.newPage();
      // Never attach project OIDC, cookies, or provider headers to preview requests.
      const response = await page.goto(input.url, { waitUntil: "load" });
      if (response && !response.ok()) {
        throw new Error(`Preview returned HTTP ${response.status()}`);
      }
      if (input.preparePage) {
        await input.preparePage(page);
      }
      await page.evaluate(async () => await document.fonts.ready);
      await runSequentially(
        Array.from({ length: input.scenarios.length + 1 }, (_, index) => index),
        async (index) => {
          const scenario = index === 0 ? undefined : input.scenarios[index - 1];
          let interaction = {
            status: "not-run",
          };
          if (scenario !== undefined) {
            const refreshed = await page.reload({ waitUntil: "load" });
            if (refreshed && !refreshed.ok()) {
              throw new Error(`Preview returned HTTP ${refreshed.status()}`);
            }
            try {
              await runSequentially(scenario.steps, async (step) => {
                const locator =
                  step.selector !== undefined && step.selector.length > 0
                    ? page.locator(step.selector)
                    : page.getByRole(parseRole(step.role), {
                        exact: true,
                        name: step.name,
                      });
                if (step.action === "click") {
                  await locator.click();
                } else if (step.action === "fill") {
                  await locator.fill(step.value ?? "");
                } else {
                  await locator.selectOption({ label: step.value ?? "" });
                }
              });
              if ((scenario.expect?.text?.length ?? 0) > 0) {
                await page
                  .getByText(scenario.expect.text, { exact: false })
                  .first()
                  .waitFor({ state: "visible" });
              }
              interaction = {
                expectedText: scenario.expect?.text ?? null,
                status: "passed",
              };
            } catch {
              interaction = {
                expectedText: scenario.expect?.text ?? null,
                status: "failed",
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
          if (styles) {
            for (const observation of styles.observations) {
              observation.capture = name;
              observation.id = `${name}-${observation.id}`;
            }
          }
          const outputPath = nodePath.join(input.output, `${name}.png`);
          await settleFiniteMotion(page);
          await page.screenshot({ fullPage: true, path: outputPath });
          captures.push({
            height: Math.max(viewport.height, measurements.documentHeight),
            interaction,
            measurements,
            name,
            path: outputPath,
            state: scenario?.name ?? "initial",
            styles,
            width: viewport.width,
          });
        },
      );
      await context.close();
    });
    return captures;
  } finally {
    await browser.close();
  }
}
