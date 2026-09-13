import type { Browser, Page } from "playwright";
import type { parse } from "postcss";

/** Translate only canonical theme declarations, preserving media/theme selectors. */
export const canonicalTokenStylesheet = (source: string, parseCSS: typeof parse) => {
  const css = parseCSS(source);
  css.walkAtRules("import", (rule) => {
    if (!/^["']tailwindcss["']$/u.test(rule.params))
      throw new Error("Canonical theme contains an unresolved import.");
    rule.remove();
  });
  css.walkAtRules("theme", (rule) => {
    if (rule.params.trim()) throw new Error("Unsupported canonical theme mode.");
    rule.replaceWith({ selector: ":root", nodes: rule.nodes });
  });
  return css.toString();
};

export const inspectSemanticColors = async (page: Page, browser: Browser, canonicalCSS: string) => {
  const mode = await page.evaluate(() => ({
    dark: matchMedia("(prefers-color-scheme: dark)").matches,
    classes: document.documentElement.className,
    theme: document.documentElement.dataset.theme,
  }));
  const samples = await page.evaluate(() => {
    const rules: CSSStyleRule[] = [];
    let unreadableSheets = 0;
    const visit = (items: CSSRuleList) => {
      for (const rule of items) {
        if (rule instanceof CSSStyleRule) rules.push(rule);
        else if (rule instanceof CSSMediaRule) {
          if (matchMedia(rule.conditionText).matches) visit(rule.cssRules);
        } else if (rule instanceof CSSSupportsRule) {
          if (CSS.supports(rule.conditionText)) visit(rule.cssRules);
        } else if (rule instanceof CSSContainerRule) {
          unreadableSheets += 1;
        } else if ("cssRules" in rule) visit((rule as CSSGroupingRule).cssRules);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        visit(sheet.cssRules);
      } catch {
        unreadableSheets += 1;
      }
    }
    const properties = ["color", "background-color", "border-top-color"];
    const values: {
      element: string;
      property: string;
      token?: string;
      actual: string;
      reason?: string;
    }[] = [];
    for (const [index, element] of [
      ...document.querySelectorAll("html, main, header, button, input, label"),
    ].entries()) {
      if (element !== document.documentElement && !element.getBoundingClientRect().width) continue;
      for (const property of properties) {
        const tokens = new Set<string>();
        for (const rule of rules) {
          try {
            if (!element.matches(rule.selectorText)) continue;
          } catch {
            continue;
          }
          for (const match of rule.style
            .getPropertyValue(property)
            .matchAll(/var\((?<token>--color-[a-z0-9-]+)/gu))
            if (match.groups?.token) tokens.add(match.groups.token);
        }
        const label = `${element.tagName.toLowerCase()}[${index}]`;
        if (tokens.size === 1)
          values.push({
            element: label,
            property,
            token: [...tokens][0],
            actual: getComputedStyle(element).getPropertyValue(property),
          });
        else
          values.push({
            element: label,
            property,
            actual: getComputedStyle(element).getPropertyValue(property),
            reason: tokens.size
              ? "Ambiguous token mapping"
              : "No directly matched semantic token declaration",
          });
      }
    }
    return { values, unreadableSheets };
  });
  const context = await browser.newContext({ colorScheme: mode.dark ? "dark" : "light" });
  try {
    await context.addInitScript("globalThis.__name = (value) => value;");
    const expected = await context.newPage();
    await expected.setContent("<!doctype html><html><body></body></html>");
    await expected.evaluate(({ classes, theme }) => {
      document.documentElement.className = classes;
      if (theme !== null) document.documentElement.dataset.theme = theme;
    }, mode);
    await expected.addStyleTag({ content: canonicalCSS });
    const resolved = await expected.evaluate(
      (values) =>
        values.map((sample) => {
          if (!sample.token) return { ...sample, status: "unassessed" };
          const tokenValue = getComputedStyle(document.documentElement)
            .getPropertyValue(sample.token)
            .trim();
          if (!tokenValue)
            return {
              ...sample,
              status: "unassessed",
              reason: "Canonical token is unavailable in this theme mode",
            };
          const probe = document.createElement("span");
          probe.style.setProperty(sample.property, `var(${sample.token})`);
          document.body.append(probe);
          const normalized = getComputedStyle(probe).getPropertyValue(sample.property);
          probe.remove();
          return {
            ...sample,
            expected: normalized,
            status: normalized === sample.actual ? "passed" : "failed",
          };
        }),
      samples.values,
    );
    const mapped = resolved.filter((sample) => sample.status !== "unassessed");
    return {
      mode,
      samples: resolved,
      unreadableSheets: samples.unreadableSheets,
      status: mapped.some((sample) => sample.status === "failed")
        ? "failed"
        : mapped.length && mapped.length === resolved.length && samples.unreadableSheets === 0
          ? "passed"
          : "unassessed",
      scope:
        "Only directly mapped visible color properties were compared. Unmapped or ambiguous properties, other states, and inaccessible stylesheets are not palette proof.",
    };
  } finally {
    await context.close();
  }
};

/** Payload binds exact runtime source paths; no generated code is changed. */
export const sandboxSemanticTokenProbe = () => ({
  artifactPaths: [],
  script: `import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { parse } from 'postcss';
import { chromium } from 'playwright';
globalThis.__name = (value) => value;
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const sources = [];
let browser;
try {
  const theme = await readFile(input.canonicalThemePath, 'utf8');
  for (const path of [input.canonicalThemePath, ...input.candidateStylesheetPaths]) {
    const content = await readFile(path, 'utf8');
    sources.push({ path, sha256: createHash('sha256').update(content).digest('hex'), content });
  }
  const css = (${canonicalTokenStylesheet.toString()})(theme, parse);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.addInitScript("globalThis.__name = (value) => value;");
  const response = await page.goto(input.baseURL, { waitUntil: 'load' });
  if (!response?.ok()) throw new Error('Candidate runtime unavailable');
  await page.getByRole('button', { name: 'Continue to review', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
  const result = await (${inspectSemanticColors.toString()})(page, browser, css);
  await writeFile(process.argv[3], JSON.stringify({ producer: 'evaluator', sources, result }));
} catch {
  await writeFile(process.argv[3], JSON.stringify({ producer: 'evaluator', sources, result: { status: 'unassessed', reason: 'Token probe could not bind exact canonical source and supported runtime controls.' } }));
} finally { await browser?.close(); }
`,
});

/** Bind only the canonical theme actually present in the archived workspace inventory. */
export const semanticTokenProbeBinding = (input: {
  runtimeRoot: string;
  candidateAppId: string;
  candidateFiles: readonly { path: string }[];
  workspacePaths: readonly string[];
}) => {
  const theme = input.workspacePaths.find(
    (path) => path === "packages/design-systems/core/tokens/theme.css",
  );
  const stylesheets = input.candidateFiles.filter((file) => file.path.endsWith(".css"));
  if (!theme || !stylesheets.length) return;
  return {
    canonicalThemePath: `${input.runtimeRoot}/${theme}`,
    candidateStylesheetPaths: stylesheets.map(
      (file) => `${input.runtimeRoot}/apps/${input.candidateAppId}/${file.path}`,
    ),
  };
};
