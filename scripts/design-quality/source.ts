import ts from "typescript";

export type SourceFile = { path: string; content: string };

export type SourceAnalysis = {
  imports: Array<{ path: string; names: string[] }>;
  tokenRefs: string[];
  semanticVarRefs: string[];
  undefinedTokens: string[];
  generatedLiterals: string[];
  matchingLiterals: string[];
  unknownLiterals: string[];
};

const varReference = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[^)]+)?\)/g;
const cssLiteral = /(?:#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)|-?(?:\d*\.\d+|\d+)(?:px|rem|em|vh|vw|vmin|vmax|deg|ms|s)\b)/g;
const structuralLiteral = /^(?:0(?:\.0+)?|auto|(?:\d*\.\d+|\d+)%|(?:inline-)?grid)$/i;

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Parse custom properties from a CSS token sheet and resolve simple var() aliases. */
export function parseTokens(css: string): Record<string, string> {
  const declared: Record<string, string> = {};
  // A declaration is deliberately bounded to a semicolon. This keeps comments,
  // selectors, and arbitrary CSS values out of the token map.
  const declaration = /(^|[;{])\s*(--[A-Za-z0-9_-]+)\s*:\s*([^;{}]+);/gm;
  for (const match of css.matchAll(declaration)) declared[match[2]] = match[3].trim();

  const resolving = new Set<string>();
  const resolve = (name: string): string => {
    const value = declared[name];
    if (!value || resolving.has(name)) return value ?? `var(${name})`;
    resolving.add(name);
    const result = value.replace(varReference, (reference, target: string) =>
      Object.hasOwn(declared, target) ? resolve(target) : reference,
    );
    resolving.delete(name);
    return result;
  };

  return Object.fromEntries(
    Object.keys(declared).map((name) => [name, resolve(name)]),
  );
}

function isSemanticToken(name: string): boolean {
  return /^(?:--color-(?:bg|text|action|border|status|chart)-|--(?:space|radius|shadow|size|text|leading|tracking)-)/.test(name);
}

function collectVarReferences(text: string, destination: string[]) {
  for (const match of text.matchAll(varReference)) destination.push(match[1]);
}

function collectCssLiterals(text: string, destination: string[]) {
  const candidate = text.trim();
  if (structuralLiteral.test(candidate)) return;
  for (const match of text.matchAll(cssLiteral)) {
    if (!structuralLiteral.test(match[0])) destination.push(match[0]);
  }
}

function jsxAttributeText(attribute: ts.JsxAttribute): string | undefined {
  if (!attribute.initializer) return undefined;
  if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression)
    return undefined;
  const expression = attribute.initializer.expression;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return expression.text;
  if (ts.isNumericLiteral(expression)) return expression.text;
  return undefined;
}

function collectStyleExpression(expression: ts.Expression, destination: string[]) {
  if (!ts.isObjectLiteralExpression(expression)) return;
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const value = property.initializer;
    if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value))
      collectCssLiterals(value.text, destination);
    else if (ts.isNumericLiteral(value)) collectCssLiterals(value.text, destination);
  }
}

/**
 * Inspect generated TSX without applying a policy gate. The report is evidence:
 * callers decide how, or whether, to score it.
 */
export function analyzeSource({ files, tokenCss }: { files: SourceFile[]; tokenCss: string }): SourceAnalysis {
  const tokens = parseTokens(tokenCss);
  const tokenRefs: string[] = [];
  const literals: string[] = [];
  const imports: Array<{ path: string; names: string[] }> = [];

  for (const file of files) {
    collectVarReferences(file.content, tokenRefs);
    const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const imported = new Set<string>();
    const usedInJsx = new Set<string>();

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
      const bindings = statement.importClause.namedBindings;
      if (statement.importClause.name) imported.add(statement.importClause.name.text);
      if (bindings && ts.isNamespaceImport(bindings)) imported.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements) imported.add(item.name.text);
    }

    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        if (ts.isIdentifier(tag)) usedInJsx.add(tag.text);
        for (const attribute of node.attributes.properties) {
          if (!ts.isJsxAttribute(attribute)) continue;
          const name = attribute.name.text;
          const text = jsxAttributeText(attribute);
          if (name === "className" && text) {
            for (const bracketed of text.matchAll(/\[([^\]]+)\]/g)) collectCssLiterals(bracketed[1], literals);
          }
          if (name === "style" && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression)
            collectStyleExpression(attribute.initializer.expression, literals);
        }
      }
      if (ts.isJsxExpression(node) && node.expression && ts.isIdentifier(node.expression))
        usedInJsx.add(node.expression.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    const names = unique([...usedInJsx].filter((name) => imported.has(name)));
    if (names.length) imports.push({ path: file.path, names });
  }

  const resolvedValues = new Set(Object.values(tokens).map(normalise));
  const generatedLiterals = unique(literals);
  const matchingLiterals = generatedLiterals.filter((value) => resolvedValues.has(normalise(value)));
  const unknownLiterals = generatedLiterals.filter((value) => !resolvedValues.has(normalise(value)));
  const uniqueRefs = unique(tokenRefs);

  return {
    imports: imports.sort((left, right) => left.path.localeCompare(right.path)),
    tokenRefs: uniqueRefs,
    semanticVarRefs: uniqueRefs.filter(isSemanticToken),
    undefinedTokens: uniqueRefs.filter((name) => !Object.hasOwn(tokens, name)),
    generatedLiterals,
    matchingLiterals,
    unknownLiterals,
  };
}
