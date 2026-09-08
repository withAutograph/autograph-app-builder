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
type EntryPoint = { module: string; path: string };

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

function packageEntryPoints(
  pkg: PackageJson,
): Array<{ suffix: string; target: string }> {
  if (typeof pkg.exports === "string")
    return [{ suffix: "", target: pkg.exports }];
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
  return pkg.types || pkg.main
    ? [{ suffix: "", target: pkg.types ?? pkg.main! }]
    : [];
}

async function aliasEntryPoints(
  root: string,
  limitations: string[],
): Promise<EntryPoint[]> {
  let parsed: ts.ParsedCommandLine;
  try {
    const config = ts.readConfigFile(
      join(root, "tsconfig.json"),
      ts.sys.readFile,
    );
    if (config.error) throw new Error();
    parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  } catch {
    limitations.push(
      "Could not read the selected Arrusted tsconfig paths; alias-backed public exports are unassessed.",
    );
    return [];
  }
  const paths = parsed.options.paths ?? {};
  const entries: EntryPoint[] = [];
  for (const module of [
    "@autograph/components",
    "@autograph/compositions",
    "@autograph/icons",
  ]) {
    const target = paths[module]?.[0];
    const path = target && sourcePath(root, target);
    if (path) entries.push({ module, path });
    else if (target)
      limitations.push(
        `Could not resolve tsconfig path for ${module}; its public types are unassessed.`,
      );
  }
  return entries;
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
  const entryPoints = await aliasEntryPoints(arrustedRoot, limitations);
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
    const entries = packageEntryPoints(pkg)
      .map(({ suffix, target }) => ({
        module: `${pkg.name}${suffix}`,
        path: sourcePath(packageRoot, target),
      }))
      .filter((entry): entry is EntryPoint => Boolean(entry.path));
    if (!entries.length) {
      limitations.push(
        `Could not resolve a TypeScript public entry point for ${pkg.name}.`,
      );
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
    const moduleSymbol =
      source && program.getTypeChecker().getSymbolAtLocation(source);
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
  return { modules, limitations };
}
