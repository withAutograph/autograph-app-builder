import { parse, type Declaration } from "postcss";

export type CssSourceFile = { path: string; content: string };
export type CssRuleEvidence = {
  selector: string;
  property: string;
  value: string;
  source: { path: string; line: number; column: number };
  ruleSignature: string;
};

// Rule tuples are exact CSS evidence. In particular, collapsing whitespace can
// change quoted strings and selectors, so only trim surrounding transport noise.
const normal = (value: string) => value.trim();
const key = (selector: string, property: string, value: string) =>
  `${normal(selector)}\u0000${property}\u0000${normal(value)}`;

function canonicalSelector(value: string) {
  let output = "";
  let pendingSpace = false;
  let quote: string | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (quote) {
      output += char;
      if (char === quote && value[index - 1] !== "\\") quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      if (pendingSpace && output) output += " ";
      pendingSpace = false;
      quote = char;
      output += char;
      continue;
    }
    if (/\s/.test(char)) {
      pendingSpace = Boolean(output);
      continue;
    }
    if (pendingSpace) {
      const previous = output.at(-1);
      if (previous && !/[>+~([,:=]/.test(previous) && !/[>+~),:=]/.test(char)) output += " ";
    }
    pendingSpace = false;
    output += char;
  }
  return output.trim();
}

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
  )
    return undefined;
  return `${canonicalSelector(selector)}\u0000${declarations
    .map(
      (declaration) =>
        `${declaration.prop}\u0000${declaration.value.trim()}\u0000${Boolean(declaration.important)}`,
    )
    .toSorted()
    .join("\u0001")}`;
}

export function collectCssRuleEvidence(files: CssSourceFile[]): CssRuleEvidence[] {
  const evidence: CssRuleEvidence[] = [];
  for (const file of files.filter((file) => /\.css$/i.test(file.path))) {
    const css = parse(file.content, { from: file.path });
    css.walkRules((rule) => {
      // Conditional rule context is not represented reliably by every CDP
      // backend, so it deliberately stays unassessed.
      if (rule.parent?.type !== "root") return;
      const declarations =
        rule.nodes?.filter((node): node is Declaration => node.type === "decl") ?? [];
      const signature = ruleSignature(rule.selector, declarations);
      if (!signature) return;
      for (const declaration of declarations) {
        const start = declaration.source?.start;
        if (!start) continue;
        evidence.push({
          selector: canonicalSelector(rule.selector),
          property: declaration.prop,
          value: normal(declaration.value),
          source: { path: file.path, line: start.line, column: start.column },
          ruleSignature: signature,
        });
      }
    });
  }
  return evidence;
}

export function generatedCssRule(
  generated: CssRuleEvidence[],
  shared: CssRuleEvidence[],
  selector: string | undefined,
  property: string,
  value: string | undefined,
  declarations: { name: string; value: string; important?: boolean }[],
) {
  if (!selector || value === undefined) return undefined;
  const tuple = key(selector, property, value);
  const matchingGenerated = generated.filter(
    (rule) => key(rule.selector, rule.property, rule.value) === tuple,
  );
  const actual = ruleSignature(
    selector,
    declarations.map((declaration) => ({
      prop: declaration.name,
      value: declaration.value,
      important: declaration.important,
    })),
  );
  const loaded = actual ? matchingGenerated.filter((rule) => rule.ruleSignature === actual) : [];
  const matchingShared = shared.filter(
    (rule) => key(rule.selector, rule.property, rule.value) === tuple,
  );
  return loaded.length === 1 && matchingGenerated.length === 1 && !matchingShared.length
    ? loaded[0]
    : undefined;
}
