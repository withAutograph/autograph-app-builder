import { parse } from "postcss";
import type { Declaration } from "postcss";

export interface CssSourceFile {
  path: string;
  content: string;
}
export interface CssRuleEvidence {
  selector: string;
  property: string;
  value: string;
  source: { path: string; line: number; column: number };
  ruleSignature: string;
}

// Rule tuples are exact CSS evidence. In particular, collapsing whitespace can
// change quoted strings and selectors, so only trim surrounding transport noise.
const normal = (value: string) => value.trim();
const key = (selector: string, property: string, value: string) =>
  `${normal(selector)}\u0000${property}\u0000${normal(value)}`;

const nextQuote = (quote: string, char: string, previous: string | undefined) =>
  char === quote && previous !== "\\" ? undefined : quote;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function canonicalSelector(value: string) {
  let output = "";
  let pendingSpace = false;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (quote !== undefined) {
      output += char;
      quote = nextQuote(quote, char, value[index - 1]);
    } else if (char === '"' || char === "'") {
      if (pendingSpace && output.length > 0) {
        output += " ";
      }
      pendingSpace = false;
      quote = char;
      output += char;
    } else if (/\s/u.test(char)) {
      pendingSpace = Boolean(output);
    } else {
      if (pendingSpace) {
        const previous = output.at(-1);
        if (previous !== undefined && !/[>+~([,:=]/u.test(previous) && !/[>+~),:=]/u.test(char)) {
          output += " ";
        }
      }
      pendingSpace = false;
      output += char;
    }
  }
  return output.trim();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function ruleSignature(
  selector: string,
  declarations: { prop: string; value: string; important?: boolean }[],
): string | undefined {
  const properties = declarations.map((declaration) => declaration.prop);
  if (
    properties.some(
      (property, index) =>
        properties.indexOf(property) !== index ||
        properties.some(
          (other) =>
            other !== property &&
            (other.startsWith(`${property}-`) || property.startsWith(`${other}-`)),
        ),
    )
  ) {
    return undefined;
  }
  return `${canonicalSelector(selector)}\u0000${declarations
    .map(
      (declaration) =>
        `${declaration.prop}\u0000${declaration.value.trim()}\u0000${Boolean(declaration.important)}`,
    )
    .toSorted()
    .join("\u0001")}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function collectCssRuleEvidence(files: CssSourceFile[]): CssRuleEvidence[] {
  const evidence: CssRuleEvidence[] = [];
  for (const file of files.filter((sourceFile) => /\.css$/iu.test(sourceFile.path))) {
    const css = parse(file.content, { from: file.path });
    css.walkRules((rule) => {
      // Conditional rule context is not represented reliably by every CDP
      // backend, so it deliberately stays unassessed.
      if (rule.parent?.type !== "root") {
        return;
      }
      const declarations =
        rule.nodes?.filter((node): node is Declaration => node.type === "decl") ?? [];
      const signature = ruleSignature(rule.selector, declarations);
      if (signature === undefined || signature === "") {
        return;
      }
      for (const declaration of declarations) {
        const start = declaration.source?.start;
        if (start === undefined) {
          continue;
        }
        evidence.push({
          property: declaration.prop,
          ruleSignature: signature,
          selector: canonicalSelector(rule.selector),
          source: { column: start.column, line: start.line, path: file.path },
          value: normal(declaration.value),
        });
      }
    });
  }
  return evidence;
}

const matchingGeneratedCssRule = (
  generated: CssRuleEvidence[],
  shared: CssRuleEvidence[],
  selector: string,
  property: string,
  value: string,
  declarations: { name: string; value: string; important?: boolean }[],
) => {
  const tuple = key(selector, property, value);
  const matchingGenerated = generated.filter(
    (rule) => key(rule.selector, rule.property, rule.value) === tuple,
  );
  const actual = ruleSignature(
    selector,
    declarations.map((declaration) => ({
      important: declaration.important,
      prop: declaration.name,
      value: declaration.value,
    })),
  );
  const loaded =
    actual === undefined || actual === ""
      ? []
      : matchingGenerated.filter((rule) => rule.ruleSignature === actual);
  const matchingShared = shared.filter(
    (rule) => key(rule.selector, rule.property, rule.value) === tuple,
  );
  return loaded.length === 1 && matchingGenerated.length === 1 && matchingShared.length === 0
    ? loaded[0]
    : undefined;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function generatedCssRule(
  generated: CssRuleEvidence[],
  shared: CssRuleEvidence[],
  selector: string | undefined,
  property: string,
  value: string | undefined,
  declarations: { name: string; value: string; important?: boolean }[],
) {
  return selector === undefined || selector === "" || value === undefined
    ? undefined
    : matchingGeneratedCssRule(generated, shared, selector, property, value, declarations);
}
