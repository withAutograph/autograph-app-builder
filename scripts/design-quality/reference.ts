import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import ts from "typescript";

export type PublicProp = {
  required: boolean;
  /** Literal values accepted by a union-typed prop, when TypeScript can prove them. */
  values?: string[];
};

export type PublicExport = {
  props?: Record<string, PublicProp>;
};

/** The target-owned public surface used by source evidence. */
export type Reference = {
  modules: Record<string, { exports: Record<string, PublicExport> }>;
  limitations: string[];
};

type PackageJson = {
  name?: string;
  exports?: unknown;
  main?: string;
  types?: string;
};

const relevantModule = /^@autograph\/(?:components|compositions|icons)(?:$|\/)/;
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

function sourcePath(packageRoot: string, target: string): string | undefined {
  const base = resolve(packageRoot, target);
  const possibilities = [
    base,
    ...sourceExtensions.map((extension) => base + extension),
  ];
  if (!extname(base))
    possibilities.push(
      ...sourceExtensions.map((extension) => join(base, `index${extension}`)),
    );
  return possibilities.find(existsSync);
}

function literalValues(
  type: ts.Type,
  checker: ts.TypeChecker,
): string[] | undefined {
  const members = (type.isUnion() ? type.types : [type]).filter(
    (member) => !(member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
  );
  const values = members
    .map((member) => {
      if (member.flags & ts.TypeFlags.StringLiteral)
        return (member as ts.StringLiteralType).value;
      if (member.flags & ts.TypeFlags.NumberLiteral)
        return String((member as ts.NumberLiteralType).value);
      return undefined;
    })
    .filter((value): value is string => value !== undefined);
  return values.length === members.length && members.length
    ? [...new Set(values)].sort()
    : undefined;
}

function propsForExport(
  symbol: ts.Symbol,
  location: ts.Node,
  checker: ts.TypeChecker,
): PublicExport {
  const type = checker.getTypeOfSymbolAtLocation(symbol, location);
  const signature = checker.getSignaturesOfType(type, ts.SignatureKind.Call)[0];
  const parameter = signature?.getParameters()[0];
  if (!parameter) return {};
  const propsType = checker.getTypeOfSymbolAtLocation(parameter, location);
  const props: Record<string, PublicProp> = {};
  for (const property of checker.getPropertiesOfType(propsType)) {
    const declaration =
      property.valueDeclaration ?? property.declarations?.[0] ?? location;
    const propertyType = checker.getTypeOfSymbolAtLocation(
      property,
      declaration,
    );
    props[property.getName()] = {
      required: !(property.flags & ts.SymbolFlags.Optional),
      ...(literalValues(propertyType, checker)
        ? { values: literalValues(propertyType, checker) }
        : {}),
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
  const manifests = await walk(arrustedRoot);
  for (const manifest of manifests) {
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(await readFile(join(arrustedRoot, manifest), "utf8"));
    } catch {
      continue;
    }
    if (!pkg.name || !relevantModule.test(pkg.name)) continue;
    const packageRoot = dirname(join(arrustedRoot, manifest));
    const targets = exportTargets(pkg.exports);
    if (!targets.length && (pkg.types || pkg.main))
      targets.push(pkg.types ?? pkg.main!);
    const entries = targets
      .map((target) => sourcePath(packageRoot, target))
      .filter((path): path is string => Boolean(path));
    if (!entries.length) {
      limitations.push(
        `Could not resolve a TypeScript public entry point for ${pkg.name}.`,
      );
      continue;
    }
    const program = ts.createProgram(entries, {
      allowJs: true,
      jsx: ts.JsxEmit.Preserve,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      skipLibCheck: true,
    });
    const checker = program.getTypeChecker();
    const exported: Record<string, PublicExport> = {};
    for (const entry of entries) {
      const source = program.getSourceFile(entry);
      if (!source) continue;
      const moduleSymbol = checker.getSymbolAtLocation(source);
      if (!moduleSymbol) continue;
      for (const symbol of checker.getExportsOfModule(moduleSymbol))
        exported[symbol.getName()] = propsForExport(symbol, source, checker);
    }
    modules[pkg.name] = { exports: exported };
  }
  if (!Object.keys(modules).length)
    limitations.push(
      "No public @autograph component, composition, or icon packages were found in the selected Arrusted checkout.",
    );
  return { modules, limitations };
}
