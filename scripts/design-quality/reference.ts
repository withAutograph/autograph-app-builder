import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import ts from "typescript";

export interface PublicProp {
  required: boolean;
  /** Literal values accepted by a union-typed prop, when TypeScript can prove them. */
  values?: string[];
  /** Broad primitive kinds proven by TypeScript; any and unknown are omitted. */
  primitiveKinds?: ("string" | "number" | "boolean")[];
}

export interface PublicExport {
  props?: Record<string, PublicProp>;
}

/** The target-owned public surface used by source evidence. */
export interface Reference {
  modules: Record<string, { exports: Record<string, PublicExport> }>;
  limitations: string[];
  arrustedRoot?: string;
}

export interface TypedJsxAttribute {
  path: string;
  start: number;
  verdict: "conforming" | "nonconforming" | "unassessed";
  reason: string;
}
export interface ImplementationDiagnostic {
  path: string;
  line: number;
  column: number;
  code: number;
  message: string;
}

interface PackageJson {
  name?: string;
  exports?: unknown;
  main?: string;
  types?: string;
}
interface EntryPoint {
  module: string;
  path: string;
}

const relevantModule = /^@autograph\/(?:components|compositions|icons)(?:$|\/)/u;
const sourceExtensions = [".tsx", ".ts", ".jsx", ".js", ".d.ts"];

async function walk(root: string, relative = ""): Promise<string[]> {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(join(root, relative), { withFileTypes: true });
  } catch {
    return result;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(relative, entry.name);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    if (entry.isDirectory()) result.push(...(await walk(root, path)));
    else if (entry.isFile() && entry.name === "package.json") result.push(path);
  }
  return result;
}

function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!value || typeof value !== "object") return [];
  return Object.values(value as Record<string, unknown>).flatMap(exportTargets);
}

function packageEntryPoints(pkg: PackageJson): { suffix: string; target: string }[] {
  if (typeof pkg.exports === "string") return [{ suffix: "", target: pkg.exports }];
  if (pkg.exports && typeof pkg.exports === "object") {
    const entries = Object.entries(pkg.exports as Record<string, unknown>)
      .filter(([key]) => key === "." || key.startsWith("./"))
      .flatMap(([key, value]) =>
        exportTargets(value).map((target) => ({
          suffix: key === "." ? "" : key.slice(1),
          target,
        })),
      );
    if (entries.length) return entries;
    const root = exportTargets(pkg.exports);
    if (root.length) return root.map((target) => ({ suffix: "", target }));
  }
  return pkg.types || pkg.main ? [{ suffix: "", target: pkg.types ?? pkg.main! }] : [];
}

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning tool or script contract
async function aliasEntryPoints(root: string, limitations: string[]): Promise<EntryPoint[]> {
  let parsed: ts.ParsedCommandLine;
  try {
    const config = ts.readConfigFile(join(root, "tsconfig.json"), ts.sys.readFile);
    if (config.error) throw new Error("Unable to read TypeScript configuration.");
    parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  } catch {
    limitations.push(
      "Could not read the selected Arrusted tsconfig paths; alias-backed public exports are unassessed.",
    );
    return [];
  }
  const paths = parsed.options.paths ?? {};
  const entries: EntryPoint[] = [];
  for (const moduleName of [
    "@autograph/components",
    "@autograph/compositions",
    "@autograph/icons",
  ]) {
    const target = paths[moduleName]?.[0];
    const path = target && sourcePath(root, target);
    if (path) entries.push({ module: moduleName, path });
    else if (target)
      limitations.push(
        `Could not resolve tsconfig path for ${moduleName}; its public types are unassessed.`,
      );
  }
  return entries;
}

function sourcePath(packageRoot: string, target: string): string | undefined {
  const base = resolve(packageRoot, target);
  const possibilities = [base, ...sourceExtensions.map((extension) => base + extension)];
  if (!extname(base))
    possibilities.push(...sourceExtensions.map((extension) => join(base, `index${extension}`)));
  return possibilities.find(existsSync);
}

function literalValues(type: ts.Type): string[] | undefined {
  const members = (type.isUnion() ? type.types : [type]).filter(
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
  );
  const values = members
    .map((member) => {
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      if (member.flags & ts.TypeFlags.StringLiteral) return (member as ts.StringLiteralType).value;
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      if (member.flags & ts.TypeFlags.NumberLiteral)
        return String((member as ts.NumberLiteralType).value);
      return undefined;
    })
    .filter((value): value is string => value !== undefined);
  return values.length === members.length && members.length
    ? [...new Set(values)].toSorted()
    : undefined;
}

function primitiveKinds(type: ts.Type): PublicProp["primitiveKinds"] {
  const members = (type.isUnion() ? type.types : [type]).filter(
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
  );
  if (
    !members.length ||
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    members.some((member) => member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
  )
    return undefined;
  const kinds = new Set<"string" | "number" | "boolean">();
  for (const member of members) {
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    if (member.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) kinds.add("string");
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    else if (member.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) kinds.add("number");
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    else if (member.flags & ts.TypeFlags.BooleanLike) kinds.add("boolean");
    else return undefined;
  }
  return [...kinds].toSorted() as PublicProp["primitiveKinds"];
}

function propsForExport(
  symbol: ts.Symbol,
  location: ts.Node,
  checker: ts.TypeChecker,
): PublicExport {
  const type = checker.getTypeOfSymbolAtLocation(symbol, location);
  const [signature] = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const parameter = signature?.getParameters()[0];
  if (!parameter) return {};
  const propsType = checker.getTypeOfSymbolAtLocation(parameter, location);
  const props: Record<string, PublicProp> = {};
  for (const property of checker.getPropertiesOfType(propsType)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const values = literalValues(propertyType);
    const primitive = values ? undefined : primitiveKinds(propertyType);
    props[property.getName()] = {
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      required: !(property.flags & ts.SymbolFlags.Optional),
      ...(values ? { values } : {}),
      ...(primitive ? { primitiveKinds: primitive } : {}),
    };
  }
  return Object.keys(props).length ? { props } : {};
}

/**
 * Read the selected Arrusted checkout rather than an App Builder catalog. Only
 * public package entry points are admitted, and TypeScript is the authority for
 * the export and prop surface.
 */
export async function readReference(arrustedRoot: string): Promise<Reference> {
  const modules: Reference["modules"] = {};
  const limitations: string[] = [];
  const entryPoints = await aliasEntryPoints(arrustedRoot, limitations);
  const manifests = await walk(arrustedRoot);
  for (const manifest of manifests) {
    let pkg: PackageJson;
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      pkg = JSON.parse(await readFile(join(arrustedRoot, manifest), "utf-8"));
    } catch {
      continue;
    }
    if (!pkg.name || !relevantModule.test(pkg.name)) continue;
    const packageRoot = dirname(join(arrustedRoot, manifest));
    const entries = packageEntryPoints(pkg)
      .map(({ suffix, target }) => ({
        module: `${pkg.name}${suffix}`,
        path: sourcePath(packageRoot, target),
      }))
      .filter((entry): entry is EntryPoint => Boolean(entry.path));
    if (!entries.length) {
      limitations.push(`Could not resolve a TypeScript public entry point for ${pkg.name}.`);
      continue;
    }
    const program = ts.createProgram(
      entries.map((entry) => entry.path),
      {
        allowJs: true,
        jsx: ts.JsxEmit.Preserve,
        module: ts.ModuleKind.NodeNext,
        moduleResolution: ts.ModuleResolutionKind.NodeNext,
        skipLibCheck: true,
      },
    );
    const checker = program.getTypeChecker();
    for (const entry of entries) {
      const source = program.getSourceFile(entry.path);
      if (!source) continue;
      const moduleSymbol = checker.getSymbolAtLocation(source);
      if (!moduleSymbol) continue;
      const exported: Record<string, PublicExport> = {};
      for (const symbol of checker.getExportsOfModule(moduleSymbol))
        exported[symbol.getName()] = propsForExport(symbol, source, checker);
      modules[entry.module] = { exports: exported };
    }
  }
  for (const entry of entryPoints) {
    if (modules[entry.module]) continue;
    const program = ts.createProgram([entry.path], {
      jsx: ts.JsxEmit.Preserve,
      skipLibCheck: true,
    });
    const source = program.getSourceFile(entry.path);
    const moduleSymbol = source && program.getTypeChecker().getSymbolAtLocation(source);
    if (!source || !moduleSymbol) {
      limitations.push(
        `Could not load TypeScript exports for ${entry.module}; its public types are unassessed.`,
      );
      continue;
    }
    const checker = program.getTypeChecker();
    const exported: Record<string, PublicExport> = {};
    for (const symbol of checker.getExportsOfModule(moduleSymbol))
      exported[symbol.getName()] = propsForExport(symbol, source, checker);
    modules[entry.module] = { exports: exported };
  }
  if (!Object.keys(modules).length)
    limitations.push(
      "No public @autograph component, composition, or icon packages were found in the selected Arrusted checkout.",
    );
  return { modules, limitations, arrustedRoot };
}

function reliableExpressionType(
  type: ts.Type,
  checker: ts.TypeChecker,
  depth = 0,
  seen = new Set<ts.Type>(),
): boolean {
  if (depth > 5 || seen.has(type)) return false;
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter))
    return false;
  const nextSeen = new Set([...seen, type]);
  if (type.isUnion() || type.isIntersection())
    return type.types.every((member) =>
      reliableExpressionType(member, checker, depth + 1, nextSeen),
    );
  if (checker.isArrayType(type) || checker.isTupleType(type))
    return checker
      .getTypeArguments(type as ts.TypeReference)
      .every((item) => reliableExpressionType(item, checker, depth + 1, nextSeen));
  if (type.getCallSignatures().length || type.getConstructSignatures().length) return false;
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  if (!(type.flags & ts.TypeFlags.Object)) return true;
  return checker.getPropertiesOfType(type).every((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    return (
      Boolean(declaration) &&
      reliableExpressionType(
        checker.getTypeOfSymbolAtLocation(property, declaration!),
        checker,
        depth + 1,
        nextSeen,
      )
    );
  });
}

function reliableExpectedAssignment(
  actual: ts.Type,
  expected: ts.Type,
  checker: ts.TypeChecker,
): boolean | undefined {
  if (!expected.isUnion())
    return reliableExpressionType(expected, checker)
      ? checker.isTypeAssignableTo(actual, expected)
      : undefined;
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  if (expected.types.some((member) => member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
    return undefined;
  if (expected.types.every((member) => reliableExpressionType(member, checker)))
    return checker.isTypeAssignableTo(actual, expected);
  const primitiveActual = Boolean(
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    actual.flags &
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    (ts.TypeFlags.String |
      ts.TypeFlags.StringLiteral |
      ts.TypeFlags.Number |
      ts.TypeFlags.NumberLiteral |
      ts.TypeFlags.Boolean |
      ts.TypeFlags.BooleanLiteral),
  );
  if (!primitiveActual) return undefined;
  const candidates = expected.types.filter((member) => reliableExpressionType(member, checker));
  if (!candidates.length) return undefined;
  if (candidates.some((member) => checker.isTypeAssignableTo(actual, member))) return true;
  return undefined;
}

/**
 * Establish that a finite JSX literal can be handed back to TypeScript for the
 * final assignability decision. This is deliberately not a second type system:
 * tuple cardinality, excess keys, required keys, and intersections remain the
 * checker's responsibility.
 */
function finiteLiteralEvidence(
  expression: ts.Expression,
  expected: ts.Type,
  checker: ts.TypeChecker,
  depth = 0,
  seen = new Set<ts.Symbol>(),
): true | undefined {
  if (depth > 8) return undefined;
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  if (expected.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
  // A JSX element or fragment is a concrete expression with a compiler-owned
  // element type. Its descendants may still be dynamic, but that does not make
  // the outer prop callback-shaped or unresolved. Do not admit any/unknown
  // types, or unions with an any/unknown escape hatch.
  if (
    ts.isJsxElement(expression) ||
    ts.isJsxSelfClosingElement(expression) ||
    ts.isJsxFragment(expression)
  ) {
    const actual = checker.getTypeAtLocation(expression);
    if (
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
      (expected.isUnion() &&
        // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
        expected.types.some((member) => member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)))
    )
      return undefined;
    return checker.isTypeAssignableTo(actual, expected) ? true : undefined;
  }
  // A generated prop may name a local, immutable JSX literal. Follow only a
  // single declaration in this source file; imports, lets, parameters, and
  // aliases with ambiguous ownership remain unassessed.
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    const declaration = symbol?.valueDeclaration;
    const declarations = symbol?.declarations;
    const list = declaration?.parent;
    if (
      !symbol ||
      seen.has(symbol) ||
      declarations?.length !== 1 ||
      !declaration ||
      !ts.isVariableDeclaration(declaration) ||
      !declaration.initializer ||
      declaration.getSourceFile() !== expression.getSourceFile() ||
      !list ||
      !ts.isVariableDeclarationList(list) ||
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      !(list.flags & ts.NodeFlags.Const)
    )
      return undefined;
    const nextSeen = new Set([...seen, symbol]);
    return finiteLiteralEvidence(declaration.initializer, expected, checker, depth + 1, nextSeen);
  }
  // A conditional is finite only when every possible branch is independently
  // finite. The condition itself may be runtime state; TypeScript remains the
  // authority for the conditional expression's final assignability.
  if (ts.isConditionalExpression(expression))
    return finiteLiteralEvidence(expression.whenTrue, expected, checker, depth + 1, seen) ===
      true &&
      finiteLiteralEvidence(expression.whenFalse, expected, checker, depth + 1, seen) === true
      ? true
      : undefined;
  if (expected.isUnion()) {
    const actual = checker.getTypeAtLocation(expression);
    return expected.types.some(
      (member) =>
        finiteLiteralEvidence(expression, member, checker, depth + 1, seen) &&
        checker.isTypeAssignableTo(actual, member),
    )
      ? true
      : undefined;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    if (!checker.isArrayType(expected) && !checker.isTupleType(expected)) return undefined;
    if (!expression.elements.length) return true;
    // Non-empty tuples need cardinality/rest handling; retain the conservative
    // existing path instead of approximating it here.
    if (checker.isTupleType(expected)) return undefined;
    const items = checker.getTypeArguments(expected as ts.TypeReference);
    if (items.length !== 1) return undefined;
    return expression.elements.every((element) =>
      ts.isExpression(element)
        ? finiteLiteralEvidence(element, items[0], checker, depth + 1, seen)
        : false,
    )
      ? true
      : undefined;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    if (
      // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
      !(expected.flags & ts.TypeFlags.Object) ||
      expected.isIntersection() ||
      expected.getCallSignatures().length ||
      expected.getConstructSignatures().length
    )
      return undefined;
    for (const property of expression.properties) {
      if (!ts.isPropertyAssignment(property) || !property.name) return undefined;
      const name = ts.isIdentifier(property.name)
        ? property.name.text
        : ts.isStringLiteral(property.name) || ts.isNumericLiteral(property.name)
          ? property.name.text
          : undefined;
      if (!name) return undefined;
      const symbol = checker.getPropertyOfType(expected, name);
      const propertyType = symbol
        ? checker.getTypeOfSymbolAtLocation(
            symbol,
            symbol.valueDeclaration ?? symbol.declarations?.[0] ?? property,
          )
        : checker.getIndexTypeOfType(expected, ts.IndexKind.String);
      if (!propertyType) return undefined;
      if (
        finiteLiteralEvidence(property.initializer, propertyType, checker, depth + 1, seen) !== true
      )
        return undefined;
    }
    return true;
  }
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return reliableExpressionType(expected, checker) ? true : undefined;
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    const actual = checker.getTypeAtLocation(expression);
    // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
    return actual.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)
      ? undefined
      : checker.isTypeAssignableTo(actual, expected)
        ? true
        : undefined;
  }
  return undefined;
}

function jsxAttributeExpectedType(
  attribute: ts.JsxAttribute,
  checker: ts.TypeChecker,
): ts.Type | undefined {
  const opening = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) return undefined;
  const symbol = checker.getSymbolAtLocation(opening.tagName);
  const component = symbol
    ? checker.getTypeOfSymbolAtLocation(symbol, opening.tagName)
    : checker.getTypeAtLocation(opening.tagName);
  const parameter = checker
    .getSignaturesOfType(component, ts.SignatureKind.Call)[0]
    ?.getParameters()[0];
  if (!parameter) return undefined;
  const props = checker.getTypeOfSymbolAtLocation(parameter, opening);
  const prop = checker.getPropertyOfType(props, attribute.name.getText());
  return prop ? checker.getTypeOfSymbolAtLocation(prop, attribute) : undefined;
}

function requiresFiniteIdentifierEvidence(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean {
  if (!ts.isIdentifier(expression)) return false;
  const actual = checker.getTypeAtLocation(expression);
  const members = actual.isUnion() ? actual.types : [actual];
  // Scalar values retain the existing reliable type-only path. JSX and object
  // aliases need finite ownership proof because a matching type alone does not
  // say whether a mutable/generated/shared value supplied the prop.
  // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
  return members.some((member) => member.flags & ts.TypeFlags.Object);
}

/**
 * Type-check generated JSX through a virtual, read-only host configured from
 * the selected Arrusted checkout. This proves assignability only, never render
 * reachability or runtime behaviour.
 */
export function checkJsxAttributes({
  arrustedRoot,
  files,
}: {
  arrustedRoot: string;
  files: { path: string; content: string }[];
}): {
  attributes: TypedJsxAttribute[];
  limitations: string[];
  implementationDiagnostics: ImplementationDiagnostic[];
} {
  const limitations: string[] = [];
  const config = ts.readConfigFile(join(arrustedRoot, "tsconfig.json"), ts.sys.readFile);
  if (config.error)
    return {
      attributes: [],
      limitations: [
        "Could not read selected Arrusted TypeScript configuration; JSX prop types are unassessed.",
      ],
      implementationDiagnostics: [],
    };
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, arrustedRoot);
  const virtual = new Map(
    files
      .filter((file) => /\.tsx?$/iu.test(file.path))
      .map((file) => [resolve(arrustedRoot, ".design-quality-virtual", file.path), file.content]),
  );
  const host = ts.createCompilerHost({ ...parsed.options, jsx: ts.JsxEmit.Preserve }, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (path) => virtual.has(path) || originalFileExists(path);
  host.readFile = (path) => virtual.get(path) ?? originalReadFile(path);
  host.getSourceFile = (path, languageVersion) => {
    const content = virtual.get(path);
    return content === undefined
      ? originalGetSourceFile(path, languageVersion)
      : ts.createSourceFile(path, content, languageVersion, true, ts.ScriptKind.TSX);
  };
  try {
    const program = ts.createProgram(
      [...virtual.keys()],
      { ...parsed.options, jsx: ts.JsxEmit.Preserve, noEmit: true },
      host,
    );
    const checker = program.getTypeChecker();
    const attributes: TypedJsxAttribute[] = [];
    const implementationDiagnostics: ImplementationDiagnostic[] = [];
    for (const [path] of virtual) {
      const source = program.getSourceFile(path);
      if (!source) continue;
      const diagnostics = program.getSemanticDiagnostics(source);
      const visit = (node: ts.Node) => {
        if (
          ts.isJsxAttribute(node) &&
          node.initializer &&
          ((ts.isJsxExpression(node.initializer) && node.initializer.expression) ||
            ts.isStringLiteral(node.initializer))
        ) {
          const expression = ts.isJsxExpression(node.initializer)
            ? node.initializer.expression!
            : node.initializer;
          const actual = ts.isStringLiteral(node.initializer)
            ? checker.getStringLiteralType(node.initializer.text)
            : checker.getTypeAtLocation(expression);
          let expected = checker.getContextualType(expression);
          // oxlint-disable-next-line eslint/no-bitwise -- Intentional bitmask or binary-flag operation.
          if (!expected || expected.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
            expected = jsxAttributeExpectedType(node, checker);
          const key = {
            path:
              files.find(
                (file) => resolve(arrustedRoot, ".design-quality-virtual", file.path) === path,
              )?.path ?? path,
            start: node.getStart(source),
          };
          const initializerStart = node.initializer.getStart(source);
          const initializerEnd = node.initializer.getEnd();
          const attributeDiagnostics = diagnostics.filter((item) => {
            const start = item.start ?? -1;
            const end = start + (item.length ?? 0);
            return start >= initializerStart && end <= initializerEnd;
          });
          const implementationOnlyDiagnostics = attributeDiagnostics.filter(
            (item) => ![2322, 2353].includes(item.code),
          );
          for (const item of implementationOnlyDiagnostics) {
            const position = source.getLineAndCharacterOfPosition(item.start ?? 0);
            implementationDiagnostics.push({
              path: key.path,
              line: position.line + 1,
              column: position.character + 1,
              code: item.code,
              message: ts.flattenDiagnosticMessageText(item.messageText, " "),
            });
          }
          const safetyDiagnostics = implementationOnlyDiagnostics.filter((item) =>
            [2531, 2532, 18_047, 18_048].includes(item.code),
          );
          const propDiagnostics = attributeDiagnostics.filter((item) =>
            [2322, 2353].includes(item.code),
          );
          if (safetyDiagnostics.length)
            attributes.push({
              ...key,
              verdict: "unassessed",
              reason:
                "A generated-source TypeScript diagnostic affects this expression; prop assignability is unassessed.",
            });
          else if (propDiagnostics.length)
            attributes.push({
              ...key,
              verdict: "nonconforming",
              reason: `TypeScript prop error: ${propDiagnostics
                .slice(0, 3)
                .map((item) => ts.flattenDiagnosticMessageText(item.messageText, " "))
                .join("; ")}`,
            });
          else if (expected) {
            const finite = finiteLiteralEvidence(expression, expected, checker);
            if (
              finite === undefined &&
              // JSX/object aliases and imports can hide mutable or
              // externally-owned values even when their widened types are
              // reliable. State bindings retain the existing type-only path.
              (requiresFiniteIdentifierEvidence(expression, checker) ||
                !reliableExpressionType(actual, checker))
            )
              attributes.push({
                ...key,
                verdict: "unassessed",
                reason:
                  "The JSX expression or expected prop type is dynamic, unresolved, any, unknown, recursive, or callback-shaped.",
              });
            else {
              const assignable = finite
                ? checker.isTypeAssignableTo(actual, expected)
                : reliableExpectedAssignment(actual, expected, checker);
              if (assignable === undefined)
                attributes.push({
                  ...key,
                  verdict: "unassessed",
                  reason:
                    "The expected prop type has no independently reliable branch for this static JSX expression.",
                });
              else
                attributes.push({
                  ...key,
                  verdict: assignable ? "conforming" : "nonconforming",
                  reason: assignable
                    ? "The static JSX expression is assignable to the selected Arrusted prop type."
                    : propDiagnostics.length
                      ? `TypeScript prop error: ${propDiagnostics
                          .slice(0, 3)
                          .map((item) => ts.flattenDiagnosticMessageText(item.messageText, " "))
                          .join("; ")}`
                      : "The static JSX expression is not assignable to the selected Arrusted prop type.",
                });
            }
          } else
            attributes.push({
              ...key,
              verdict: "unassessed",
              reason:
                "The JSX expression or expected prop type is dynamic, unresolved, any, unknown, recursive, or callback-shaped.",
            });
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return { attributes, limitations, implementationDiagnostics };
  } catch {
    limitations.push(
      "Selected Arrusted TypeScript types could not be loaded for generated JSX; prop conformance is unassessed.",
    );
    return { attributes: [], limitations, implementationDiagnostics: [] };
  }
}
