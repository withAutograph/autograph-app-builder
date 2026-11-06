import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import nodePath from "node:path";
import ts = require("typescript");
import { z } from "zod";
import { runSequentially } from "../../lib/async-sequential";

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
  exports?: PackageExport;
  main?: string;
  types?: string;
}
type PackageExport =
  | { kind: "target"; target: string }
  | { kind: "map"; entries: PackageExportMap };
interface PackageExportMap {
  [key: string]: PackageExport;
}
interface EntryPoint {
  module: string;
  path: string;
}

const relevantModule = /^@autograph\/(?:components|compositions|icons)(?:$|\/)/u;
const sourceExtensions = [".tsx", ".ts", ".jsx", ".js", ".d.ts"];

const walk = async (root: string, relative = ""): Promise<string[]> => {
  const result: string[] = [];
  let entries;
  try {
    entries = await readdir(nodePath.join(root, relative), { withFileTypes: true });
  } catch {
    return result;
  }
  await runSequentially(entries, async (entry) => {
    if (entry.name !== "node_modules" && !entry.name.startsWith(".")) {
      const entryPath = nodePath.join(relative, entry.name);
      if (entry.isDirectory()) {
        result.push(...(await walk(root, entryPath)));
      } else if (entry.isFile() && entry.name === "package.json") {
        result.push(entryPath);
      }
    }
  });
  return result;
};

const packageExportSchema: z.ZodType<PackageExport> = z.lazy(() =>
  z.union([
    z.string().transform((target) => ({ kind: "target" as const, target })),
    z
      .record(z.string(), packageExportSchema)
      .transform((entries) => ({ entries, kind: "map" as const })),
  ]),
);
const packageJsonSchema = z.object({
  exports: packageExportSchema.optional(),
  main: z.string().optional(),
  name: z.string().optional(),
  types: z.string().optional(),
});

const exportTargets = (value: PackageExport): string[] =>
  value.kind === "target" ? [value.target] : Object.values(value.entries).flatMap(exportTargets);

const packageEntryPoints = (pkg: PackageJson): { suffix: string; target: string }[] => {
  const { exports } = pkg;
  if (exports?.kind === "map") {
    const entries = Object.entries(exports.entries)
      .filter(([key]) => key === "." || key.startsWith("./"))
      .flatMap(([key, value]) =>
        exportTargets(value).map((target) => ({
          suffix: key === "." ? "" : key.slice(1),
          target,
        })),
      );
    if (entries.length) {
      return entries;
    }
    const root = exportTargets(exports);
    if (root.length) {
      return root.map((target) => ({ suffix: "", target }));
    }
  }
  if (exports?.kind === "target") {
    return [{ suffix: "", target: exports.target }];
  }
  const target = pkg.types ?? pkg.main;
  return target === undefined ? [] : [{ suffix: "", target }];
};

const sourcePath = (packageRoot: string, target: string): string | undefined => {
  const base = nodePath.resolve(packageRoot, target);
  const possibilities = [base, ...sourceExtensions.map((extension) => base + extension)];
  if (!nodePath.extname(base)) {
    possibilities.push(
      ...sourceExtensions.map((extension) => nodePath.join(base, `index${extension}`)),
    );
  }
  return possibilities.find(existsSync);
};

const aliasEntryPoints = (root: string, limitations: string[]): EntryPoint[] => {
  let parsed: ts.ParsedCommandLine;
  try {
    const configPath = nodePath.join(root, "tsconfig.json");
    const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
    if (config.error) {
      throw new Error("Unable to read TypeScript configuration.");
    }
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
    if (path !== undefined) {
      entries.push({ module: moduleName, path });
    } else if (target !== undefined) {
      limitations.push(
        `Could not resolve tsconfig path for ${moduleName}; its public types are unassessed.`,
      );
    }
  }
  return entries;
};

const literalValues = (type: ts.Type): string[] | undefined => {
  const members = (type.isUnion() ? type.types : [type]).filter(
    (member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
  );
  const values = members
    .map((member) => {
      if (member.isStringLiteral()) {
        // SAFETY: The literal type predicate establishes the string value.
        return member.value;
      }
      if (member.isNumberLiteral()) {
        // SAFETY: The literal type predicate establishes the numeric value.
        return String(member.value);
      }
      return null;
    })
    .filter((value): value is string => value !== null);
  return values.length === members.length && members.length
    ? [...new Set(values)].toSorted()
    : undefined;
};

const primitiveKinds = (type: ts.Type): PublicProp["primitiveKinds"] => {
  const members = (type.isUnion() ? type.types : [type]).filter(
    (member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
  );
  if (
    !members.length ||
    members.some((member) => member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))
  ) {
    return undefined;
  }
  const kinds = new Set<"string" | "number" | "boolean">();
  for (const member of members) {
    if (member.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) {
      kinds.add("string");
    } else if (member.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) {
      kinds.add("number");
    } else if (member.flags & ts.TypeFlags.BooleanLike) {
      kinds.add("boolean");
    } else {
      return undefined;
    }
  }
  return [...kinds].toSorted();
};

const propsForExport = (
  symbol: ts.Symbol,
  location: ts.Node,
  checker: ts.TypeChecker,
): PublicExport => {
  const type = checker.getTypeOfSymbolAtLocation(symbol, location);
  const [signature] = checker.getSignaturesOfType(type, ts.SignatureKind.Call);
  const parameter = signature?.getParameters()[0];
  if (parameter === undefined) {
    return {};
  }
  const propsType = checker.getTypeOfSymbolAtLocation(parameter, location);
  const props: Record<string, PublicProp> = {};
  for (const property of checker.getPropertiesOfType(propsType)) {
    const declaration = property.valueDeclaration ?? property.declarations?.[0] ?? location;
    const propertyType = checker.getTypeOfSymbolAtLocation(property, declaration);
    const values = literalValues(propertyType);
    const primitive = values ? undefined : primitiveKinds(propertyType);
    const publicProp: PublicProp = {
      required: !(property.flags & ts.SymbolFlags.Optional),
    };
    if (values !== undefined) {
      publicProp.values = values;
    }
    if (primitive !== undefined) {
      publicProp.primitiveKinds = primitive;
    }
    props[property.getName()] = publicProp;
  }
  return Object.keys(props).length ? { props } : {};
};

const parsePackageJson = (input: string): PackageJson | undefined => {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return undefined;
  }
  const parsed = packageJsonSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

/**
 * Read the selected Arrusted checkout rather than an App Builder catalog. Only
 * public package entry points are admitted, and TypeScript is the authority for
 * the export and prop surface.
 */
export const readReference = async (arrustedRoot: string): Promise<Reference> => {
  const modules: Reference["modules"] = {};
  const limitations: string[] = [];
  const entryPoints = aliasEntryPoints(arrustedRoot, limitations);
  const manifests = await walk(arrustedRoot);
  const packageInputs = await Promise.all(
    manifests.map(async (manifest) => {
      let text: string | null = null;
      try {
        text = await readFile(nodePath.join(arrustedRoot, manifest), "utf-8");
      } catch {
        text = null;
      }
      return { manifest, text };
    }),
  );
  for (const { manifest, text } of packageInputs) {
    const pkg = text === null ? undefined : parsePackageJson(text);
    if (pkg?.name !== undefined && pkg.name.length > 0 && relevantModule.test(pkg.name)) {
      readPackageExports(arrustedRoot, manifest, pkg, modules, limitations);
    }
  }
  for (const entry of entryPoints) {
    if (modules[entry.module] === undefined) {
      const program = ts.createProgram([entry.path], {
        jsx: ts.JsxEmit.Preserve,
        skipLibCheck: true,
      });
      const source = program.getSourceFile(entry.path);
      const moduleSymbol = source && program.getTypeChecker().getSymbolAtLocation(source);
      if (source === undefined || moduleSymbol === undefined) {
        limitations.push(
          `Could not load TypeScript exports for ${entry.module}; its public types are unassessed.`,
        );
      } else {
        const checker = program.getTypeChecker();
        const exported: Record<string, PublicExport> = {};
        for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
          exported[symbol.getName()] = propsForExport(symbol, source, checker);
        }
        modules[entry.module] = { exports: exported };
      }
    }
  }
  if (Object.keys(modules).length === 0) {
    limitations.push(
      "No public @autograph component, composition, or icon packages were found in the selected Arrusted checkout.",
    );
  }
  return { arrustedRoot, limitations, modules };
};

const readPackageExports = (
  arrustedRoot: string,
  manifest: string,
  pkg: PackageJson,
  modules: Reference["modules"],
  limitations: string[],
): void => {
  const packageRoot = nodePath.dirname(nodePath.join(arrustedRoot, manifest));
  const entries: EntryPoint[] = [];
  for (const { suffix, target } of packageEntryPoints(pkg)) {
    const path = sourcePath(packageRoot, target);
    if (path !== undefined) {
      entries.push({ module: `${pkg.name}${suffix}`, path });
    }
  }
  if (!entries.length) {
    limitations.push(`Could not resolve a TypeScript public entry point for ${pkg.name}.`);
    return;
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
    const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source);
    if (source !== undefined && moduleSymbol !== undefined) {
      const exported: Record<string, PublicExport> = {};
      for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
        exported[symbol.getName()] = propsForExport(symbol, source, checker);
      }
      modules[entry.module] = { exports: exported };
    }
  }
};

const reliableExpressionType = (
  type: ts.Type,
  checker: ts.TypeChecker,
  depth = 0,
  seen = new Set<ts.Type>(),
): boolean => {
  if (depth > 5 || seen.has(type)) {
    return false;
  }
  if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter)) {
    return false;
  }
  const nextSeen = new Set([...seen, type]);
  if (type.isUnion() || type.isIntersection()) {
    return type.types.every((member) =>
      reliableExpressionType(member, checker, depth + 1, nextSeen),
    );
  }
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const itemType = type.getNumberIndexType();
    return itemType !== undefined && reliableExpressionType(itemType, checker, depth + 1, nextSeen);
  }
  if (type.getCallSignatures().length || type.getConstructSignatures().length) {
    return false;
  }
  if (!(type.flags & ts.TypeFlags.Object)) {
    return true;
  }
  return checker.getPropertiesOfType(type).every((property) => {
    const declaration = property.valueDeclaration ?? property.declarations?.[0];
    if (!declaration) {
      return false;
    }
    return reliableExpressionType(
      checker.getTypeOfSymbolAtLocation(property, declaration),
      checker,
      depth + 1,
      nextSeen,
    );
  });
};

const reliableExpectedAssignment = (
  actual: ts.Type,
  expected: ts.Type,
  checker: ts.TypeChecker,
): boolean | undefined => {
  if (!expected.isUnion()) {
    return reliableExpressionType(expected, checker)
      ? checker.isTypeAssignableTo(actual, expected)
      : undefined;
  }
  if (expected.types.some((member) => member.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
    return undefined;
  }
  if (expected.types.every((member) => reliableExpressionType(member, checker))) {
    return checker.isTypeAssignableTo(actual, expected);
  }
  const primitiveActual = Boolean(
    actual.flags &
    (ts.TypeFlags.String |
      ts.TypeFlags.StringLiteral |
      ts.TypeFlags.Number |
      ts.TypeFlags.NumberLiteral |
      ts.TypeFlags.Boolean |
      ts.TypeFlags.BooleanLiteral),
  );
  if (!primitiveActual) {
    return undefined;
  }
  const candidates = expected.types.filter((member) => reliableExpressionType(member, checker));
  if (!candidates.length) {
    return undefined;
  }
  if (candidates.some((member) => checker.isTypeAssignableTo(actual, member))) {
    return true;
  }
  return undefined;
};

const containsUnsafeType = (type: ts.Type): boolean =>
  type.flags === ts.TypeFlags.Any || type.flags === ts.TypeFlags.Unknown;

const isJsxElementExpression = (expression: ts.Expression): boolean =>
  ts.isJsxElement(expression) ||
  ts.isJsxSelfClosingElement(expression) ||
  ts.isJsxFragment(expression);

const isLocalConstInitializer = (
  symbol: ts.Symbol | undefined,
  declaration: ts.Declaration | undefined,
  declarations: readonly ts.Declaration[] | undefined,
  list: ts.Node | undefined,
  expression: ts.Identifier,
  seen: Set<ts.Symbol>,
): declaration is ts.VariableDeclaration & { initializer: ts.Expression } =>
  symbol !== undefined &&
  !seen.has(symbol) &&
  declarations?.length === 1 &&
  declaration !== undefined &&
  ts.isVariableDeclaration(declaration) &&
  declaration.initializer !== undefined &&
  declaration.getSourceFile() === expression.getSourceFile() &&
  list !== undefined &&
  ts.isVariableDeclarationList(list) &&
  list.flags === ts.NodeFlags.Const;

const isFinitePrimitiveLiteral = (expression: ts.Expression): boolean => {
  const literal =
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword;
  return literal;
};

const finiteLiteralEvidence = (
  expression: ts.Expression,
  expected: ts.Type,
  checker: ts.TypeChecker,
  depth = 0,
  seen = new Set<ts.Symbol>(),
): true | undefined => {
  if (depth > 8 || containsUnsafeType(expected)) {
    return undefined;
  }
  if (isJsxElementExpression(expression)) {
    return checker.isTypeAssignableTo(checker.getTypeAtLocation(expression), expected)
      ? true
      : undefined;
  }
  if (ts.isIdentifier(expression)) {
    return identifierLiteralEvidence(expression, expected, checker, depth, seen);
  }
  if (ts.isConditionalExpression(expression)) {
    return finiteConditionalEvidence(expression, expected, checker, depth, seen);
  }
  if (expected.isUnion()) {
    return unionLiteralEvidence(expression, expected, checker, depth, seen);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    return finiteArrayEvidence(expression, expected, checker, depth, seen);
  }
  if (ts.isObjectLiteralExpression(expression)) {
    return finiteObjectEvidence(expression, expected, checker, depth, seen);
  }
  if (isFinitePrimitiveLiteral(expression)) {
    return reliableExpressionType(expected, checker) ? true : undefined;
  }
  if (expression.kind === ts.SyntaxKind.NullKeyword) {
    const actual = checker.getTypeAtLocation(expression);
    if (containsUnsafeType(actual)) {
      return undefined;
    }
    return checker.isTypeAssignableTo(actual, expected) ? true : undefined;
  }
  return undefined;
};

const identifierLiteralEvidence = (
  expression: ts.Identifier,
  expected: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
  seen: Set<ts.Symbol>,
): true | undefined => {
  const symbol = checker.getSymbolAtLocation(expression);
  const declaration = symbol?.valueDeclaration;
  if (
    !isLocalConstInitializer(
      symbol,
      declaration,
      symbol?.declarations,
      declaration?.parent,
      expression,
      seen,
    )
  ) {
    return undefined;
  }
  return finiteLiteralEvidence(
    declaration.initializer,
    expected,
    checker,
    depth + 1,
    new Set([...seen, symbol]),
  );
};

const unionLiteralEvidence = (
  expression: ts.Expression,
  expected: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
  seen: Set<ts.Symbol>,
): true | undefined => {
  const actual = checker.getTypeAtLocation(expression);
  if (!expected.isUnion()) {
    return undefined;
  }
  for (const member of expected.types) {
    const hasFiniteEvidence = finiteLiteralEvidence(expression, member, checker, depth + 1, seen);
    if (hasFiniteEvidence === true && checker.isTypeAssignableTo(actual, member)) {
      return true;
    }
  }
  return undefined;
};

const finiteConditionalEvidence = (
  expression: ts.ConditionalExpression,
  expected: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
  seen: Set<ts.Symbol>,
): true | undefined => {
  const trueBranch = finiteLiteralEvidence(expression.whenTrue, expected, checker, depth + 1, seen);
  if (trueBranch !== true) {
    return undefined;
  }
  const falseBranch = finiteLiteralEvidence(
    expression.whenFalse,
    expected,
    checker,
    depth + 1,
    seen,
  );
  return falseBranch === true ? true : undefined;
};

const finiteArrayEvidence = (
  expression: ts.ArrayLiteralExpression,
  expected: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
  seen: Set<ts.Symbol>,
): true | undefined => {
  if (
    (!checker.isArrayType(expected) && !checker.isTupleType(expected)) ||
    !expression.elements.length
  ) {
    return expression.elements.length === 0 &&
      (checker.isArrayType(expected) || checker.isTupleType(expected))
      ? true
      : undefined;
  }
  if (checker.isTupleType(expected)) {
    return undefined;
  }
  const itemType = expected.getNumberIndexType();
  return itemType !== undefined &&
    expression.elements.every(
      (element) =>
        ts.isExpression(element) &&
        finiteLiteralEvidence(element, itemType, checker, depth + 1, seen) === true,
    )
    ? true
    : undefined;
};

const finiteObjectEvidence = (
  expression: ts.ObjectLiteralExpression,
  expected: ts.Type,
  checker: ts.TypeChecker,
  depth: number,
  seen: Set<ts.Symbol>,
): true | undefined => {
  if (
    expected.flags !== ts.TypeFlags.Object ||
    expected.isIntersection() ||
    expected.getCallSignatures().length > 0 ||
    expected.getConstructSignatures().length > 0
  ) {
    return undefined;
  }
  for (const property of expression.properties) {
    if (!ts.isPropertyAssignment(property)) {
      return undefined;
    }
    const name =
      ts.isIdentifier(property.name) ||
      ts.isStringLiteral(property.name) ||
      ts.isNumericLiteral(property.name)
        ? property.name.text
        : undefined;
    if (name === undefined || name.length === 0) {
      return undefined;
    }
    const symbol = checker.getPropertyOfType(expected, name);
    const propertyType = symbol
      ? checker.getTypeOfSymbolAtLocation(
          symbol,
          symbol.valueDeclaration ?? symbol.declarations?.[0] ?? property,
        )
      : checker.getIndexTypeOfType(expected, ts.IndexKind.String);
    if (
      propertyType === undefined ||
      finiteLiteralEvidence(property.initializer, propertyType, checker, depth + 1, seen) !== true
    ) {
      return undefined;
    }
  }
  return true;
};

const evidenceForJsxAttribute = (
  expression: ts.Expression,
  actual: ts.Type,
  expected: ts.Type | undefined,
  checker: ts.TypeChecker,
): TypedJsxAttribute["verdict"] => {
  if (expected === undefined) {
    return "unassessed";
  }
  const finite = finiteLiteralEvidence(expression, expected, checker);
  if (
    finite === undefined &&
    (requiresFiniteIdentifierEvidence(expression, checker) ||
      !reliableExpressionType(actual, checker))
  ) {
    return "unassessed";
  }
  const assignable =
    finite === true
      ? checker.isTypeAssignableTo(actual, expected)
      : reliableExpectedAssignment(actual, expected, checker);
  if (assignable === undefined) {
    return "unassessed";
  }
  return assignable ? "conforming" : "nonconforming";
};

/**
 * Establish that a finite JSX literal can be handed back to TypeScript for the
 * final assignability decision. This is deliberately not a second type system:
 * tuple cardinality, excess keys, required keys, and intersections remain the
 * checker's responsibility.
 */
const jsxAttributeExpectedType = (
  attribute: ts.JsxAttribute,
  checker: ts.TypeChecker,
): ts.Type | undefined => {
  const opening = attribute.parent.parent;
  if (!ts.isJsxOpeningElement(opening) && !ts.isJsxSelfClosingElement(opening)) {
    return undefined;
  }
  const symbol = checker.getSymbolAtLocation(opening.tagName);
  const component = symbol
    ? checker.getTypeOfSymbolAtLocation(symbol, opening.tagName)
    : checker.getTypeAtLocation(opening.tagName);
  const parameter = checker
    .getSignaturesOfType(component, ts.SignatureKind.Call)[0]
    ?.getParameters()[0];
  if (parameter === undefined) {
    return undefined;
  }
  const props = checker.getTypeOfSymbolAtLocation(parameter, opening);
  const prop = checker.getPropertyOfType(props, attribute.name.getText());
  return prop ? checker.getTypeOfSymbolAtLocation(prop, attribute) : undefined;
};

const requiresFiniteIdentifierEvidence = (
  expression: ts.Expression,
  checker: ts.TypeChecker,
): boolean => {
  if (!ts.isIdentifier(expression)) {
    return false;
  }
  const actualType: ts.Type = checker.getTypeAtLocation(expression);
  const members: readonly ts.Type[] = actualType.isUnion() ? actualType.types : [actualType];
  // Scalar values retain the existing reliable type-only path. JSX and object
  // aliases need finite ownership proof because a matching type alone does not
  // say whether a mutable/generated/shared value supplied the prop.
  return members.some((member) => member.flags & ts.TypeFlags.Object);
};

/**
 * Type-check generated JSX through a virtual, read-only host configured from
 * the selected Arrusted checkout. This proves assignability only, never render
 * reachability or runtime behaviour.
 */
interface JsxAttributeCheckResult {
  attributes: TypedJsxAttribute[];
  limitations: string[];
  implementationDiagnostics: ImplementationDiagnostic[];
}

export const checkJsxAttributes = ({
  arrustedRoot,
  files,
}: {
  arrustedRoot: string;
  files: { path: string; content: string }[];
}): JsxAttributeCheckResult => {
  const limitations: string[] = [];
  const configPath = nodePath.join(arrustedRoot, "tsconfig.json");
  const config = ts.readConfigFile(configPath, (path) => ts.sys.readFile(path));
  if (config.error) {
    return {
      attributes: [],
      implementationDiagnostics: [],
      limitations: [
        "Could not read selected Arrusted TypeScript configuration; JSX prop types are unassessed.",
      ],
    };
  }
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, arrustedRoot);
  const virtual = new Map(
    files
      .filter((file) => /\.tsx?$/iu.test(file.path))
      .map((file) => [
        nodePath.resolve(arrustedRoot, ".design-quality-virtual", file.path),
        file.content,
      ]),
  );
  const host = ts.createCompilerHost({ ...parsed.options, jsx: ts.JsxEmit.Preserve }, true);
  const originalFileExists = (path: string) => host.fileExists(path);
  const originalReadFile = (path: string) => host.readFile(path);
  const originalGetSourceFile = (path: string, languageVersion: ts.ScriptTarget) =>
    host.getSourceFile(path, languageVersion);
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
      if (!source) {
        continue;
      }
      const diagnostics = program.getSemanticDiagnostics(source);
      const visit = (node: ts.Node) => {
        if (isAssessableJsxAttribute(node)) {
          const expression = ts.isJsxExpression(node.initializer)
            ? (node.initializer.expression ?? node.initializer)
            : node.initializer;
          const actual = ts.isStringLiteral(node.initializer)
            ? checker.getStringLiteralType(node.initializer.text)
            : checker.getTypeAtLocation(expression);
          let expected = checker.getContextualType(expression);
          if (expected === undefined || containsUnsafeType(expected)) {
            expected = jsxAttributeExpectedType(node, checker);
          }
          const key = {
            path:
              files.find(
                (file) =>
                  nodePath.resolve(arrustedRoot, ".design-quality-virtual", file.path) === path,
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
              code: item.code,
              column: position.character + 1,
              line: position.line + 1,
              message: ts.flattenDiagnosticMessageText(item.messageText, " "),
              path: key.path,
            });
          }
          const safetyDiagnostics = implementationOnlyDiagnostics.filter((item) =>
            [2531, 2532, 18_047, 18_048].includes(item.code),
          );
          const propDiagnostics = attributeDiagnostics.filter((item) =>
            [2322, 2353].includes(item.code),
          );
          if (safetyDiagnostics.length) {
            attributes.push({
              ...key,
              reason:
                "A generated-source TypeScript diagnostic affects this expression; prop assignability is unassessed.",
              verdict: "unassessed",
            });
          } else if (propDiagnostics.length) {
            attributes.push({
              ...key,
              reason: `TypeScript prop error: ${propDiagnostics
                .slice(0, 3)
                .map((item) => ts.flattenDiagnosticMessageText(item.messageText, " "))
                .join("; ")}`,
              verdict: "nonconforming",
            });
          } else if (expected === undefined) {
            attributes.push({
              ...key,
              reason:
                "The JSX expression or expected prop type is dynamic, unresolved, any, unknown, recursive, or callback-shaped.",
              verdict: "unassessed",
            });
          } else {
            const verdict: TypedJsxAttribute["verdict"] = evidenceForJsxAttribute(
              expression,
              actual,
              expected,
              checker,
            );
            attributes.push({
              ...key,
              reason: reasonForVerdict(verdict),
              verdict,
            });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    return { attributes, implementationDiagnostics, limitations } satisfies JsxAttributeCheckResult;
  } catch {
    limitations.push(
      "Selected Arrusted TypeScript types could not be loaded for generated JSX; prop conformance is unassessed.",
    );
    return {
      attributes: [],
      implementationDiagnostics: [],
      limitations,
    } satisfies JsxAttributeCheckResult;
  }
};

const isAssessableJsxAttribute = (node: ts.Node): node is ts.JsxAttribute => {
  if (!ts.isJsxAttribute(node) || node.initializer === undefined) {
    return false;
  }
  if (ts.isStringLiteral(node.initializer)) {
    return true;
  }
  return ts.isJsxExpression(node.initializer) && node.initializer.expression !== undefined;
};

const reasonForVerdict = (verdict: TypedJsxAttribute["verdict"]): string => {
  if (verdict === "unassessed") {
    return "The JSX expression or expected prop type cannot be independently assessed.";
  }
  if (verdict === "conforming") {
    return "The static JSX expression is assignable to the selected Arrusted prop type.";
  }
  return "The static JSX expression is not assignable to the selected Arrusted prop type.";
};
