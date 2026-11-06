import ts from "typescript";

export interface SourceFile {
  path: string;
  content: string;
}

export interface IntrinsicClassSignature {
  tag: string;
  classes: string[];
  source: { path: string; line: number; column: number };
}

export interface ClassTokenEvidence {
  token: string;
  source: IntrinsicClassSignature["source"];
}

function staticClassName(attribute: ts.JsxAttribute): string | undefined {
  const { initializer } = attribute;
  if (!initializer) {
    return undefined;
  }
  if (ts.isStringLiteral(initializer)) {
    return initializer.text;
  }
  if (
    ts.isJsxExpression(initializer) &&
    initializer.expression &&
    ts.isStringLiteral(initializer.expression)
  ) {
    return initializer.expression.text;
  }
  return undefined;
}

/**
 * These are source candidates, not a CSS provenance claim. A candidate is only
 * useful when the browser sees the exact intrinsic tag and complete class list.
 */
export function collectIntrinsicClassSignatures(files: SourceFile[]): IntrinsicClassSignature[] {
  const candidates: IntrinsicClassSignature[] = [];
  for (const file of files.filter((sourceFile) => /\.tsx?$/iu.test(sourceFile.path))) {
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (!ts.isIdentifier(node.tagName) || !/^[a-z]/u.test(node.tagName.text)) {
          ts.forEachChild(node, visit);
          return;
        }
        const attribute = node.attributes.properties.find(
          (candidateAttribute): candidateAttribute is ts.JsxAttribute =>
            ts.isJsxAttribute(candidateAttribute) &&
            ts.isIdentifier(candidateAttribute.name) &&
            candidateAttribute.name.text === "className",
        );
        const value = attribute && staticClassName(attribute);
        const classes =
          value !== undefined && value !== ""
            ? [...new Set(value.trim().split(/\s+/u).filter(Boolean))].toSorted()
            : [];
        if (!classes.length) {
          ts.forEachChild(node, visit);
          return;
        }
        const start = source.getLineAndCharacterOfPosition(node.getStart(source));
        candidates.push({
          classes,
          source: {
            column: start.character + 1,
            line: start.line + 1,
            path: file.path,
          },
          tag: node.tagName.text.toLowerCase(),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return candidates;
}

/**
 * Collect static utility tokens from intrinsic className attributes and the
 * local `cx("...")` composition convention. These are reviewer candidates,
 * not declaration provenance.
 */
export function collectClassTokenEvidence(files: SourceFile[]): ClassTokenEvidence[] {
  const candidates: ClassTokenEvidence[] = [];
  const add = (source: ts.SourceFile, node: ts.Node, value: string) => {
    const start = source.getLineAndCharacterOfPosition(node.getStart(source));
    for (const token of value.trim().split(/\s+/u).filter(Boolean)) {
      candidates.push({
        source: {
          column: start.character + 1,
          line: start.line + 1,
          path: source.fileName,
        },
        token,
      });
    }
  };
  for (const file of files.filter((sourceFile) => /\.tsx?$/iu.test(sourceFile.path))) {
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === "className") {
        const value = staticClassName(node);
        if (value !== undefined && value !== "") {
          add(source, node, value);
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "cx"
      ) {
        for (const argument of node.arguments) {
          if (ts.isStringLiteral(argument) || ts.isNoSubstitutionTemplateLiteral(argument)) {
            add(source, argument, argument.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return candidates;
}

const signatureKey = (tag: string, classes: string[]) =>
  `${tag}:${[...classes].toSorted().join(" ")}`;

/** Returns a source only for a unique full DOM signature. */
export function uniqueIntrinsicSignature(
  signatures: IntrinsicClassSignature[],
  tag: string,
  classes: string[],
) {
  const key = signatureKey(tag, classes);
  const matches = signatures.filter(
    (signature) => signatureKey(signature.tag, signature.classes) === key,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export interface SignatureAttribution {
  provenance: "generated" | "shared" | "unknown";
  source?: IntrinsicClassSignature["source"];
}

/**
 * Generated source alone cannot exclude a shared component using the same DOM
 * shape. Omit the shared inventory and this intentionally returns unknown.
 */
export function signatureAttribution(
  generated: IntrinsicClassSignature[],
  shared: IntrinsicClassSignature[] | undefined,
  tag: string,
  classes: string[],
): SignatureAttribution {
  if (!shared) {
    return { provenance: "unknown" };
  }
  const generatedMatch = uniqueIntrinsicSignature(generated, tag, classes);
  const sharedMatch = uniqueIntrinsicSignature(shared, tag, classes);
  if (generatedMatch && sharedMatch) {
    return { provenance: "unknown" };
  }
  if (generatedMatch) {
    return { provenance: "generated", source: generatedMatch.source };
  }
  if (sharedMatch) {
    return { provenance: "shared", source: sharedMatch.source };
  }
  return { provenance: "unknown" };
}

/** Compound, grouped, or stateful selectors deliberately do not prove origin. */
export function exactClassSelector(selector: string | undefined): string | undefined {
  if (selector === undefined || selector === "") {
    return undefined;
  }
  const trimmed = selector.trim();
  return /^\.[A-Za-z_-][A-Za-z0-9_-]*$/u.test(trimmed) ? trimmed.slice(1) : undefined;
}

export function generatedSignatureSelector(
  signature: IntrinsicClassSignature | undefined,
  selector: string | undefined,
) {
  const className = exactClassSelector(selector);
  return (
    signature !== undefined && className !== undefined && signature.classes.includes(className)
  );
}

const readSelectorToken = (
  selector: string,
  start: number,
): { index: number; token: string } | null => {
  let token = "";
  let index = start;
  for (; index < selector.length; index += 1) {
    const { [index]: character } = selector;
    if (character === undefined) {
      return null;
    }
    if (character === "\\") {
      const escaped = selector[index + 1];
      if (escaped === undefined || escaped === "") {
        return null;
      }
      token += escaped;
      index += 1;
    } else if (character === "[") {
      break;
    } else if (/[A-Za-z0-9_-]/u.test(character)) {
      token += character;
    } else {
      return null;
    }
  }
  return token === "" ? null : { index, token };
};

const skipAttributeSelector = (selector: string, start: number): number | null => {
  let index = start + 1;
  let quote: string | null = null;
  for (; index < selector.length; index += 1) {
    const character = selector[index];
    if (character === undefined) {
      return null;
    }
    if (character === "\\") {
      if (index + 1 >= selector.length) {
        return null;
      }
      index += 1;
    } else if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "]") {
      return index + 1;
    } else if (character === "[") {
      return null;
    }
  }
  return null;
};

/** Reads one escaped Tailwind utility token, optionally followed by attribute state. */
export function escapedTailwindClassToken(selector: string | undefined): string | undefined {
  if (selector === undefined || !selector.startsWith(".")) {
    return undefined;
  }
  const parsed = readSelectorToken(selector, 1);
  if (parsed === null) {
    return undefined;
  }
  let { index } = parsed;
  while (index < selector.length) {
    const remaining = selector.slice(index);
    const [character] = remaining;
    if (character !== "[") {
      return undefined;
    }
    const next = skipAttributeSelector(selector, index);
    if (next === null) {
      return undefined;
    }
    index = next;
  }
  return parsed.token;
}

export function classTokenAttribution(
  generated: ClassTokenEvidence[],
  shared: ClassTokenEvidence[] | undefined,
  selector: string | undefined,
): SignatureAttribution {
  const token = escapedTailwindClassToken(selector);
  if (token === undefined || shared === undefined) {
    return { provenance: "unknown" };
  }
  const generatedMatches = generated.filter((candidate) => candidate.token === token);
  const sharedMatches = shared.filter((candidate) => candidate.token === token);
  if (generatedMatches.length + sharedMatches.length !== 1) {
    return { provenance: "unknown" };
  }
  const match = generatedMatches[0] ?? sharedMatches[0];
  if (match === undefined) {
    return { provenance: "unknown" };
  }
  return {
    provenance: generatedMatches.length ? "generated" : "shared",
    source: match.source,
  };
}
