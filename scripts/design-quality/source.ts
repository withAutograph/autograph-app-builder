import postcss from "postcss";
import { posix } from "node:path";
import ts from "typescript";

import type { Observation } from "./evidence";
import { checkJsxAttributes, type Reference } from "./reference";

export type SourceFile = { path: string; content: string };

export type SourceAnalysis = {
  imports: Array<{
    path: string;
    source: string;
    name: string;
    localName: string;
  }>;
  tokenRefs: string[];
  semanticVarRefs: string[];
  undefinedTokens: string[];
  generatedLiterals: string[];
  matchingLiterals: string[];
  unknownLiterals: string[];
  observations: Observation[];
  implementationDiagnostics: Array<{
    path: string;
    line: number;
    column: number;
    code: number;
    message: string;
  }>;
  limitations: string[];
};

const varReference = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[^)]+)?\)/g;
const cssLiteral =
  /(?:#[0-9a-fA-F]{3,8}\b|(?:rgb|hsl)a?\([^)]*\)|-?(?:\d*\.\d+|\d+)(?:px|rem|em|vh|vw|vmin|vmax|deg|ms|s)\b)/g;
const structuralLiteral =
  /^(?:0(?:\.0+)?(?:px|rem|em|vh|vw|vmin|vmax|deg|ms|s)?|auto|(?:\d*\.\d+|\d+)%|(?:inline-)?grid)$/i;
const autographUiImport = /^@autograph\/(?:components|compositions|icons)(?:\/|$)/;

function unique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function normalise(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Parse custom properties from a CSS token sheet and resolve simple var() aliases. */
export function parseTokens(css: string): Record<string, string> {
  const declared: Record<string, string> = {};
  postcss.parse(css).walkDecls(/^--/, (declaration) => {
    declared[declaration.prop] = declaration.value.trim();
  });

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

  return Object.fromEntries(Object.keys(declared).map((name) => [name, resolve(name)]));
}

function isSemanticToken(name: string): boolean {
  return /^(?:--color-(?:bg|text|action|border|status|chart)-|--(?:space|radius|shadow|size|text|leading|tracking)-)/.test(
    name,
  );
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
  const { expression } = attribute.initializer;
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

function jsxRootIdentifier(tag: ts.JsxTagNameExpression): string | undefined {
  if (ts.isIdentifier(tag)) return tag.text;
  // TypeScript represents `<Icons.Check />` as a PropertyAccessExpression.
  if (!ts.isPropertyAccessExpression(tag)) return undefined;
  let { expression } = tag;
  while (ts.isPropertyAccessExpression(expression)) ({ expression } = expression);
  return ts.isIdentifier(expression) ? expression.text : undefined;
}

function collectCssFile(content: string, tokenRefs: string[], literals: string[]) {
  postcss.parse(content).walkDecls((declaration) => {
    collectVarReferences(declaration.value, tokenRefs);
    collectCssLiterals(declaration.value, literals);
  });
}

function position(source: ts.SourceFile, node: ts.Node) {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  return {
    path: source.fileName,
    line: start.line + 1,
    column: start.character + 1,
  };
}

function staticLiteral(attribute: ts.JsxAttribute): string | undefined {
  return jsxAttributeText(attribute);
}

function literalKind(attribute: ts.JsxAttribute): "string" | "number" | "boolean" | undefined {
  if (!attribute.initializer) return "boolean";
  if (ts.isStringLiteral(attribute.initializer)) return "string";
  if (!ts.isJsxExpression(attribute.initializer) || !attribute.initializer.expression)
    return undefined;
  const { expression } = attribute.initializer;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression))
    return "string";
  if (ts.isNumericLiteral(expression)) return "number";
  if (
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  )
    return "boolean";
  return undefined;
}

function containsJsx(node: ts.Node): boolean {
  let found = false;
  const inspect = (child: ts.Node) => {
    if (ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child) || ts.isJsxFragment(child)) {
      found = true;
      return;
    }
    if (!found) ts.forEachChild(child, inspect);
  };
  inspect(node);
  return found;
}

function isStaticallyFalse(expression: ts.Expression | undefined): boolean {
  return Boolean(
    expression &&
    (expression.kind === ts.SyntaxKind.FalseKeyword ||
      (ts.isNumericLiteral(expression) && expression.text === "0")),
  );
}

function exportedEntries(source: ts.SourceFile): ts.Node[] {
  const entries: ts.Node[] = [];
  for (const statement of source.statements) {
    const exported = Boolean(
      ts.getCombinedModifierFlags(statement as unknown as ts.Declaration) & ts.ModifierFlags.Export,
    );
    if (
      ts.isFunctionDeclaration(statement) &&
      (exported || statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
    )
      entries.push(statement);
    if (ts.isVariableStatement(statement) && exported) entries.push(statement);
    if (ts.isExportAssignment(statement)) entries.push(statement.expression);
  }
  return entries;
}

function publicImport(
  imported: Map<string, { source: string; name: string }>,
  tag: ts.JsxTagNameExpression,
) {
  const root = jsxRootIdentifier(tag);
  return root ? imported.get(root) : undefined;
}

function observation(
  id: string,
  dimension: Observation["dimension"],
  verdict: Observation["verdict"],
  summary: string,
  source?: Observation["source"],
  classification?: string,
): Observation {
  return {
    id,
    dimension,
    verdict,
    provenance: "generated",
    evidence: "static",
    summary,
    ...(source ? { source } : {}),
    ...(classification ? { classification } : {}),
  };
}

function isStructuralProperty(name: string): boolean {
  return /^(?:width|max-?width|min-?width|height|max-?height|min-?height|grid-?template-?columns|grid-?template-?rows)$/i.test(
    name,
  );
}

function containsNativeControl(node: ts.Node): boolean {
  if (
    (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
    ts.isIdentifier(node.tagName) &&
    /^(button|input|select|textarea)$/.test(node.tagName.text)
  )
    return true;
  return ts.forEachChild(node, containsNativeControl) ?? false;
}

/**
 * Inspect generated TSX without applying a policy gate. The report is evidence:
 * callers decide how, or whether, to score it.
 */
export function analyzeSource({
  files,
  tokenCss,
  reference,
}: {
  files: SourceFile[];
  tokenCss: string;
  reference?: Reference;
}): SourceAnalysis {
  const tokens = parseTokens(tokenCss);
  const tokenRefs: string[] = [];
  const literals: string[] = [];
  const imports: SourceAnalysis["imports"] = [];
  const observations: Observation[] = [];
  const limitations: string[] = [...(reference?.limitations ?? [])];
  const typedJsx = reference?.arrustedRoot
    ? checkJsxAttributes({ arrustedRoot: reference.arrustedRoot, files })
    : undefined;
  if (typedJsx) limitations.push(...typedJsx.limitations);
  const typedAttributes = new Map(
    typedJsx?.attributes.map((attribute) => [`${attribute.path}:${attribute.start}`, attribute]),
  );
  const implementationDiagnostics = [
    ...new Map(
      (typedJsx?.implementationDiagnostics ?? []).map((diagnostic) => [
        `${diagnostic.path}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}:${diagnostic.message}`,
        diagnostic,
      ]),
    ).values(),
  ];
  const reachableCss = new Set<string>();
  const referencedClasses = new Set<string>();
  for (const file of files.filter((candidate) => !/\.css$/i.test(candidate.path))) {
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    if (!exportedEntries(source).length) continue;
    for (const match of file.content.matchAll(/className\s*=\s*["']([^"']+)["']/g))
      for (const name of match[1].split(/\s+/))
        if (name && !name.includes("[")) referencedClasses.add(name);
    for (const statement of source.statements)
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        /\.css$/i.test(statement.moduleSpecifier.text)
      )
        reachableCss.add(
          posix.normalize(posix.join(posix.dirname(file.path), statement.moduleSpecifier.text)),
        );
  }

  for (const file of files) {
    if (/\.css$/i.test(file.path)) {
      if (!reachableCss.has(posix.normalize(file.path))) {
        // Preserve the legacy inventory, but do not turn dead CSS into scored evidence.
        collectCssFile(file.content, tokenRefs, literals);
        limitations.push(
          `${file.path} is not statically imported by an exported entry; its CSS is unassessed.`,
        );
        continue;
      }
      collectCssFile(file.content, tokenRefs, literals);
      const css = postcss.parse(file.content, { from: file.path });
      css.walkDecls((declaration) => {
        const selector =
          declaration.parent?.type === "rule" ? declaration.parent.selector : undefined;
        const selectorUsed =
          !selector || [...referencedClasses].some((name) => selector.includes(`.${name}`));
        const source = declaration.source?.start
          ? {
              path: file.path,
              line: declaration.source.start.line,
              column: declaration.source.start.column,
            }
          : undefined;
        if (declaration.prop.startsWith("--")) {
          observations.push(
            observation(
              `styling:redefinition:${file.path}:${declaration.source?.start?.line ?? 0}:${declaration.prop}`,
              "styling",
              "nonconforming",
              `Generated source redefines token ${declaration.prop}.`,
              source,
              "token-redefinition",
            ),
          );
        }
        const refs: string[] = [];
        collectVarReferences(declaration.value, refs);
        for (const ref of refs)
          observations.push(
            observation(
              `styling:var:${file.path}:${declaration.source?.start?.line ?? 0}:${ref}`,
              "styling",
              selectorUsed && Object.hasOwn(tokens, ref) && isSemanticToken(ref)
                ? "conforming"
                : "unassessed",
              selectorUsed && Object.hasOwn(tokens, ref) && isSemanticToken(ref)
                ? `CSS declaration uses declared semantic token ${ref}.`
                : `CSS declaration references ${ref}, whose semantic token status cannot be established.`,
              source,
              "token-reference",
            ),
          );
        const declarationLiterals: string[] = [];
        collectCssLiterals(declaration.value, declarationLiterals);
        for (const literal of declarationLiterals) {
          if (isStructuralProperty(declaration.prop)) continue;
          observations.push(
            observation(
              `styling:literal:${file.path}:${declaration.source?.start?.line ?? 0}:${literal}`,
              "styling",
              selectorUsed ? "nonconforming" : "unassessed",
              selectorUsed
                ? `CSS declaration uses raw literal ${literal}; matching a token value is not token provenance.`
                : `CSS selector is not referenced by static rendered class evidence.`,
              source,
              "raw-literal",
            ),
          );
        }
      });
      continue;
    }
    collectVarReferences(file.content, tokenRefs);
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const imported = new Map<string, { source: string; name: string }>();
    const unresolvedImports = new Set<string>();
    const localDeclarations = new Set<string>();
    const usedInJsx = new Set<string>();

    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const moduleSource = statement.moduleSpecifier.text;
      const bindings = statement.importClause.namedBindings;
      const isAutograph = autographUiImport.test(moduleSource);
      if (statement.importClause.name)
        if (isAutograph)
          imported.set(statement.importClause.name.text, {
            source: moduleSource,
            name: "default",
          });
        else unresolvedImports.add(statement.importClause.name.text);
      if (bindings && ts.isNamespaceImport(bindings))
        if (isAutograph) imported.set(bindings.name.text, { source: moduleSource, name: "*" });
        else unresolvedImports.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements)
          if (isAutograph)
            imported.set(item.name.text, {
              source: moduleSource,
              name: item.propertyName?.text ?? item.name.text,
            });
          else unresolvedImports.add(item.name.text);
    }
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && containsNativeControl(statement))
        localDeclarations.add(statement.name.text);
      if (ts.isClassDeclaration(statement) && statement.name && containsNativeControl(statement))
        localDeclarations.add(statement.name.text);
      if (ts.isVariableStatement(statement))
        for (const declaration of statement.declarationList.declarations)
          if (ts.isIdentifier(declaration.name) && containsNativeControl(declaration))
            localDeclarations.add(declaration.name.text);
    }

    const seenEntries = exportedEntries(source);
    if (!seenEntries.length) {
      limitations.push(
        `${file.path} has no statically identifiable exported entry; its JSX reachability is unassessed.`,
      );
      continue;
    }
    const visit = (node: ts.Node, entry?: ts.Node): void => {
      if (entry && node !== entry && ts.isFunctionLike(node)) return;
      if (ts.isBlock(node)) {
        for (const statement of node.statements) {
          visit(statement, entry);
          if (ts.isReturnStatement(statement)) return;
        }
        return;
      }
      if (ts.isIfStatement(node) && isStaticallyFalse(node.expression)) {
        if (node.elseStatement) visit(node.elseStatement);
        return;
      }
      if (ts.isConditionalExpression(node) && isStaticallyFalse(node.condition)) {
        visit(node.whenFalse);
        return;
      }
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
        isStaticallyFalse(node.left)
      )
        return;
      if (
        ts.isConditionalExpression(node) &&
        !isStaticallyFalse(node.condition) &&
        (containsJsx(node.whenTrue) || containsJsx(node.whenFalse))
      ) {
        observations.push(
          observation(
            `component:dynamic-reachability:${file.path}:${node.getStart(source)}`,
            "component",
            "unassessed",
            "A JSX branch has dynamic reachability; static source cannot establish that it renders.",
            position(source, node),
            "dynamic-reachability",
          ),
        );
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tag = node.tagName;
        const root = jsxRootIdentifier(tag);
        const item = publicImport(imported, tag);
        if (root) usedInJsx.add(root);
        for (const attribute of node.attributes.properties) {
          if (ts.isJsxSpreadAttribute(attribute)) {
            if (item)
              observations.push(
                observation(
                  `api:spread:${file.path}:${attribute.getStart(source)}`,
                  "api",
                  "unassessed",
                  `${item.name} receives spread props; their public type conformance cannot be established statically.`,
                  position(source, attribute),
                  "spread-props",
                ),
              );
            continue;
          }
          const name = attribute.name.getText(source);
          const text = jsxAttributeText(attribute);
          if (name === "className" && text) {
            for (const bracketed of text.matchAll(/\[([^\]]+)\]/g)) {
              const prefix = text.slice(0, bracketed.index).split(/\s/).at(-1) ?? "";
              if (/(?:^|:)(?:(?:min-|max-)?[wh]|grid-cols|grid-rows)-$/.test(prefix)) continue;
              collectCssLiterals(bracketed[1], literals);
              const refs: string[] = [];
              collectVarReferences(bracketed[1], refs);
              for (const ref of refs)
                observations.push(
                  observation(
                    `styling:class-var:${file.path}:${attribute.getStart(source)}:${ref}`,
                    "styling",
                    item && /(?:^|:)(?:bg|text|border)-$/.test(prefix) && ref.startsWith("--color-")
                      ? "nonconforming"
                      : Object.hasOwn(tokens, ref) && isSemanticToken(ref)
                        ? "conforming"
                        : "unassessed",
                    item && /(?:^|:)(?:bg|text|border)-$/.test(prefix) && ref.startsWith("--color-")
                      ? `Generated class overrides ${item.name}'s color treatment; prefer supported variants.`
                      : Object.hasOwn(tokens, ref) && isSemanticToken(ref)
                        ? `className uses declared semantic token ${ref}.`
                        : `className references ${ref}, whose semantic status cannot be established.`,
                    position(source, attribute),
                    "token-reference",
                  ),
                );
              const classLiterals: string[] = [];
              collectCssLiterals(bracketed[1], classLiterals);
              for (const literal of classLiterals)
                observations.push(
                  observation(
                    `styling:class-literal:${file.path}:${attribute.getStart(source)}:${literal}`,
                    "styling",
                    "nonconforming",
                    `className uses raw literal ${literal}; matching a token value is not token provenance.`,
                    position(source, attribute),
                    "raw-literal",
                  ),
                );
            }
          }
          if (
            name === "style" &&
            attribute.initializer &&
            ts.isJsxExpression(attribute.initializer) &&
            attribute.initializer.expression
          )
            collectStyleExpression(attribute.initializer.expression, literals);
          if (
            name === "style" &&
            attribute.initializer &&
            ts.isJsxExpression(attribute.initializer) &&
            attribute.initializer.expression &&
            ts.isObjectLiteralExpression(attribute.initializer.expression)
          )
            for (const property of attribute.initializer.expression.properties) {
              if (!ts.isPropertyAssignment(property)) continue;
              const value = property.initializer;
              if (
                !ts.isStringLiteral(value) &&
                !ts.isNoSubstitutionTemplateLiteral(value) &&
                !ts.isNumericLiteral(value)
              ) {
                observations.push(
                  observation(
                    `styling:style-dynamic:${file.path}:${property.getStart(source)}`,
                    "styling",
                    "unassessed",
                    "A style value is dynamic; static token provenance cannot be established.",
                    position(source, property),
                    "dynamic-style",
                  ),
                );
                continue;
              }
              const refs: string[] = [];
              collectVarReferences(value.text, refs);
              for (const ref of refs)
                observations.push(
                  observation(
                    `styling:style-var:${file.path}:${property.getStart(source)}:${ref}`,
                    "styling",
                    item && /^(?:color|background|border)/i.test(property.name.getText(source))
                      ? "nonconforming"
                      : Object.hasOwn(tokens, ref) && isSemanticToken(ref)
                        ? "conforming"
                        : "unassessed",
                    item && /^(?:color|background|border)/i.test(property.name.getText(source))
                      ? `Public ${item.name} receives a generated color treatment override.`
                      : Object.hasOwn(tokens, ref) && isSemanticToken(ref)
                        ? `style uses declared semantic token ${ref}.`
                        : `style references ${ref}, whose semantic status cannot be established.`,
                    position(source, property),
                    "token-reference",
                  ),
                );
              const styleLiterals: string[] = [];
              collectCssLiterals(value.text, styleLiterals);
              for (const literal of styleLiterals) {
                if (isStructuralProperty(property.name.getText(source))) continue;
                observations.push(
                  observation(
                    `styling:style-literal:${file.path}:${property.getStart(source)}:${literal}`,
                    "styling",
                    "nonconforming",
                    `style uses raw literal ${literal}; matching a token value is not token provenance.`,
                    position(source, property),
                    "raw-literal",
                  ),
                );
              }
            }
          if (item && reference) {
            const declaration = reference.modules[item.source]?.exports[item.name];
            if (!declaration) {
              observations.push(
                observation(
                  `api:export:${file.path}:${attribute.getStart(source)}:${item.name}`,
                  "api",
                  "unassessed",
                  `${item.name} could not be found in the selected Arrusted public exports.`,
                  position(source, node),
                  "export",
                ),
              );
            } else if (!declaration.props) {
              observations.push(
                observation(
                  `api:type:${file.path}:${attribute.getStart(source)}:${name}`,
                  "api",
                  "unassessed",
                  `${item.name}'s public prop type could not be resolved; ${name} is not credited or rejected.`,
                  position(source, attribute),
                  "type-unresolved",
                ),
              );
            } else if (name !== "children" && name !== "key" && !declaration.props[name]) {
              observations.push(
                observation(
                  `api:prop:${file.path}:${attribute.getStart(source)}:${name}`,
                  "api",
                  "nonconforming",
                  `${item.name} has no public ${name} prop in the selected Arrusted type surface.`,
                  position(source, attribute),
                  "prop",
                ),
              );
            } else if (declaration.props?.[name]) {
              const typed = typedAttributes.get(`${file.path}:${attribute.getStart(source)}`);
              const value = staticLiteral(attribute);
              const allowed = declaration.props[name].values;
              const acceptedPrimitives = declaration.props[name].primitiveKinds;
              const kind = literalKind(attribute);
              observations.push(
                observation(
                  `api:prop:${file.path}:${attribute.getStart(source)}:${name}`,
                  "api",
                  typed
                    ? typed.verdict
                    : value === undefined || !kind
                      ? "unassessed"
                      : allowed
                        ? allowed.includes(value)
                          ? "conforming"
                          : "nonconforming"
                        : acceptedPrimitives
                          ? acceptedPrimitives.includes(kind)
                            ? "conforming"
                            : "nonconforming"
                          : "unassessed",
                  typed
                    ? typed.reason
                    : value === undefined
                      ? `${item.name}.${name} is dynamic or spread-derived; its public variant cannot be verified statically.`
                      : !kind
                        ? `${item.name}.${name} is not a static primitive literal.`
                        : !allowed && !acceptedPrimitives
                          ? `${item.name}.${name}'s primitive type cannot be resolved.`
                          : !allowed && acceptedPrimitives?.includes(kind)
                            ? `${item.name}.${name} accepts static ${kind} values.`
                            : !allowed
                              ? `${item.name}.${name} does not accept static ${kind} values.`
                              : allowed.includes(value)
                                ? `${item.name}.${name} uses public variant ${JSON.stringify(value)}.`
                                : `${item.name}.${name} uses ${JSON.stringify(value)}, outside the public variants.`,
                  position(source, attribute),
                  "prop",
                ),
              );
            }
          }
        }
        if (item)
          observations.push(
            observation(
              `component:public:${file.path}:${node.getStart(source)}`,
              "component",
              !reference || !reference.modules[item.source]?.exports[item.name]
                ? "unassessed"
                : "conforming",
              `${item.name} is used from ${item.source}.`,
              position(source, node),
              "public-component",
            ),
          );
        else if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text) && localDeclarations.has(tag.text))
          observations.push(
            observation(
              `component:local:${file.path}:${node.getStart(source)}`,
              "component",
              "nonconforming",
              `Local custom visual control ${tag.text} is rendered instead of a selected public component.`,
              position(source, node),
              "local-control",
            ),
          );
        else if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text) && unresolvedImports.has(tag.text))
          observations.push(
            observation(
              `component:unresolved:${file.path}:${node.getStart(source)}`,
              "component",
              "unassessed",
              `${tag.text} comes from a non-Arrusted import; static source cannot classify it as a local replacement.`,
              position(source, node),
              "unresolved-component",
            ),
          );
        else if (ts.isIdentifier(tag) && /^[A-Z]/.test(tag.text))
          observations.push(
            observation(
              `component:unknown:${file.path}:${node.getStart(source)}`,
              "component",
              "unassessed",
              `${tag.text}'s implementation cannot be resolved statically.`,
              position(source, node),
              "unresolved-component",
            ),
          );
        else if (ts.isIdentifier(tag) && /^(button|input|select|textarea)$/.test(tag.text))
          observations.push(
            observation(
              `component:native:${file.path}:${node.getStart(source)}`,
              "component",
              "nonconforming",
              `Native ${tag.text} control is rendered instead of a selected public component.`,
              position(source, node),
              "local-control",
            ),
          );
      }
      if (ts.isJsxExpression(node) && node.expression && ts.isIdentifier(node.expression))
        usedInJsx.add(node.expression.text);
      ts.forEachChild(node, visit);
    };
    for (const entry of seenEntries) visit(entry, entry);
    for (const localName of unique([...usedInJsx].filter((name) => imported.has(name)))) {
      const item = imported.get(localName);
      if (item) imports.push({ path: file.path, localName, ...item });
    }
  }

  const resolvedValues = new Set(Object.values(tokens).map(normalise));
  const generatedLiterals = unique(literals);
  const matchingLiterals = generatedLiterals.filter((value) =>
    resolvedValues.has(normalise(value)),
  );
  const unknownLiterals = generatedLiterals.filter(
    (value) => !resolvedValues.has(normalise(value)),
  );
  const uniqueRefs = unique(tokenRefs);

  return {
    imports: imports.sort(
      (left, right) =>
        left.path.localeCompare(right.path) ||
        left.source.localeCompare(right.source) ||
        left.localName.localeCompare(right.localName),
    ),
    tokenRefs: uniqueRefs,
    semanticVarRefs: uniqueRefs.filter(isSemanticToken),
    undefinedTokens: uniqueRefs.filter((name) => !Object.hasOwn(tokens, name)),
    generatedLiterals,
    matchingLiterals,
    unknownLiterals,
    observations: observations.sort((left, right) => left.id.localeCompare(right.id)),
    implementationDiagnostics,
    limitations: unique(limitations),
  };
}
