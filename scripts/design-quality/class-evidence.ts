import ts from "typescript";

export type SourceFile = { path: string; content: string };

export type IntrinsicClassSignature = {
  tag: string;
  classes: string[];
  source: { path: string; line: number; column: number };
};

function staticClassName(attribute: ts.JsxAttribute): string | undefined {
  const initializer = attribute.initializer;
  if (!initializer) return undefined;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (
    ts.isJsxExpression(initializer) &&
    initializer.expression &&
    ts.isStringLiteral(initializer.expression)
  )
    return initializer.expression.text;
  return undefined;
}

/**
 * These are source candidates, not a CSS provenance claim. A candidate is only
 * useful when the browser sees the exact intrinsic tag and complete class list.
 */
export function collectIntrinsicClassSignatures(
  files: SourceFile[],
): IntrinsicClassSignature[] {
  const candidates: IntrinsicClassSignature[] = [];
  for (const file of files.filter((file) => /\.tsx?$/i.test(file.path))) {
    const source = ts.createSourceFile(
      file.path,
      file.content,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        if (
          !ts.isIdentifier(node.tagName) ||
          !/^[a-z]/.test(node.tagName.text)
        ) {
          ts.forEachChild(node, visit);
          return;
        }
        const attribute = node.attributes.properties.find(
          (attribute): attribute is ts.JsxAttribute =>
            ts.isJsxAttribute(attribute) &&
            ts.isIdentifier(attribute.name) &&
            attribute.name.text === "className",
        );
        const value = attribute && staticClassName(attribute);
        const classes = value
          ? [...new Set(value.trim().split(/\s+/).filter(Boolean))].sort()
          : [];
        if (!classes.length) {
          ts.forEachChild(node, visit);
          return;
        }
        const start = source.getLineAndCharacterOfPosition(
          node.getStart(source),
        );
        candidates.push({
          tag: node.tagName.text.toLowerCase(),
          classes,
          source: {
            path: file.path,
            line: start.line + 1,
            column: start.character + 1,
          },
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return candidates;
}

const signatureKey = (tag: string, classes: string[]) =>
  `${tag}:${[...classes].sort().join(" ")}`;

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

export type SignatureAttribution = {
  provenance: "generated" | "shared" | "unknown";
  source?: IntrinsicClassSignature["source"];
};

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
  if (!shared) return { provenance: "unknown" };
  const generatedMatch = uniqueIntrinsicSignature(generated, tag, classes);
  const sharedMatch = uniqueIntrinsicSignature(shared, tag, classes);
  if (generatedMatch && sharedMatch) return { provenance: "unknown" };
  if (generatedMatch)
    return { provenance: "generated", source: generatedMatch.source };
  if (sharedMatch) return { provenance: "shared", source: sharedMatch.source };
  return { provenance: "unknown" };
}

/** Compound, grouped, or stateful selectors deliberately do not prove origin. */
export function exactClassSelector(selector: string | undefined) {
  if (!selector || !/^\.[A-Za-z_-][A-Za-z0-9_-]*$/.test(selector.trim()))
    return undefined;
  return selector.trim().slice(1);
}

export function generatedSignatureSelector(
  signature: IntrinsicClassSignature | undefined,
  selector: string | undefined,
) {
  const className = exactClassSelector(selector);
  return Boolean(
    signature && className && signature.classes.includes(className),
  );
}
