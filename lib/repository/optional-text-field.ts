import { z } from "zod";

const identifier = z.string().regex(/^[a-z][a-z0-9_]*$/u);

export const optionalTextFieldSchema = z.strictObject({
  changeTypeIds: z.array(identifier).optional(),
  fieldId: identifier,
  label: z.string().trim().min(1),
  modelId: identifier,
});

export type OptionalTextField = z.infer<typeof optionalTextFieldSchema>;

interface Token {
  offset: number;
  text: string;
}
interface SourceRange {
  end: number;
  start: number;
}
interface Edit {
  length: number;
  offset: number;
  text: string;
}

const unsupported = () =>
  new Error(
    "Builder could not safely add the optional text field to this CUE layout. Inspect the current schema, preserve its existing fields and metadata exactly, and author the new optional field and release version through the ordinary app changes input.",
  );

/** Recognize direct list/struct literals and leave the original CUE bytes untouched. */
const sourceTokens = (source: string): Token[] => {
  const tokens: Token[] = [];
  const lexeme = /\s+|\/\/[^\n]*|"(?:[^"\\\r\n]|\\.)*"|[#\p{L}_$][#\p{L}\p{N}_$]*|[^\s]/gu;
  for (const match of source.matchAll(lexeme)) {
    const [text] = match;
    if (/^\s|^\/\//u.test(text)) {
      continue;
    }
    if (['"', "'", "#"].includes(text) || text.includes("\\(")) {
      throw unsupported();
    }
    tokens.push({ text, offset: match.index });
  }
  return tokens;
};

const directTokens = (tokens: Token[], range: SourceRange): number[] => {
  const direct: number[] = [];
  const expected: string[] = [];
  const closing = new Map([
    ["{", "}"],
    ["[", "]"],
    ["(", ")"],
  ]);
  for (let index = range.start; index < range.end; index += 1) {
    const { text } = tokens[index];
    if (expected.length === 0) {
      direct.push(index);
    }
    const close = closing.get(text);
    if (close !== undefined) {
      expected.push(close);
    } else if (["}", "]", ")"].includes(text) && expected.pop() !== text) {
      throw unsupported();
    }
  }
  if (expected.length !== 0) {
    throw unsupported();
  }
  return direct;
};

const quotedTokenText = (text: string): string => {
  const result: unknown = JSON.parse(text);
  return z.string().parse(result);
};

const property = (tokens: Token[], range: SourceRange, key: string): number => {
  const found = directTokens(tokens, range).filter((index) => {
    const { text } = tokens[index];
    return (
      tokens[index + 1]?.text === ":" &&
      (text === key || (text.startsWith('"') && quotedTokenText(text) === key))
    );
  });
  if (found.length !== 1) {
    throw unsupported();
  }
  return found[0] + 2;
};

const quotedValue = (token: Token | undefined): string => {
  if (token === undefined || !token.text.startsWith('"')) {
    throw unsupported();
  }
  return quotedTokenText(token.text);
};

const literalRange = (
  tokens: Token[],
  start: number,
  open: "{" | "[",
  end: number,
): SourceRange => {
  if (tokens[start]?.text !== open) {
    throw unsupported();
  }
  const close = open === "{" ? "}" : "]";
  let depth = 1;
  for (let index = start + 1; index < end; index += 1) {
    const { text } = tokens[index];
    if (text === open) {
      depth += 1;
    } else if (text === close) {
      depth -= 1;
    }
    if (depth === 0) {
      return { start: start + 1, end: index };
    }
  }
  throw unsupported();
};

const uniqueLiteral = (tokens: Token[], values: SourceRange[], id: string): SourceRange => {
  const matches = values.filter(
    (value) => quotedValue(tokens[property(tokens, value, "id")]) === id,
  );
  if (matches.length !== 1) {
    throw unsupported();
  }
  return matches[0];
};

const literalList = (tokens: Token[], range: SourceRange, kind: "struct" | "string"): number[] => {
  const entries = directTokens(tokens, range);
  const values = entries.filter((_, index) => index % 2 === 0);
  const invalid = entries.some((index, position) => {
    const { text } = tokens[index];
    if (position % 2 === 1) {
      return text !== ",";
    }
    return kind === "struct" ? text !== "{" : !text.startsWith('"');
  });
  if (invalid) {
    throw unsupported();
  }
  return values;
};

const structList = (tokens: Token[], range: SourceRange): SourceRange[] =>
  literalList(tokens, range, "struct").map((index) => literalRange(tokens, index, "{", range.end));

const listInsertion = (tokens: Token[], range: SourceRange, text: string): Edit => {
  const last = tokens[range.end - 1];
  const afterValue = range.start < range.end && last.text !== ",";
  const offset = afterValue ? last.offset + last.text.length : tokens[range.end].offset;
  return { offset, length: 0, text: afterValue ? `, ${text}` : `${text},` };
};

const changeTypeEdits = (
  tokens: Token[],
  manifest: SourceRange,
  input: OptionalTextField,
): Edit[] => {
  const ids = input.changeTypeIds ?? [];
  if (new Set(ids).size !== ids.length) {
    throw unsupported();
  }
  if (ids.length === 0) {
    return [];
  }
  const changeTypes = literalRange(
    tokens,
    property(tokens, manifest, "change_types"),
    "[",
    manifest.end,
  );
  const changes = structList(tokens, changeTypes);
  return ids.flatMap((id) => {
    const change = uniqueLiteral(tokens, changes, id);
    if (quotedValue(tokens[property(tokens, change, "model")]) !== input.modelId) {
      throw unsupported();
    }
    const touches = literalRange(tokens, property(tokens, change, "touches"), "[", change.end);
    // An empty touches list already means unrestricted fields.
    const fields = literalList(tokens, touches, "string");
    const field = JSON.stringify(input.fieldId);
    if (fields.some((index) => quotedValue(tokens[index]) === input.fieldId)) {
      throw unsupported();
    }
    return fields.length === 0 ? [] : [listInsertion(tokens, touches, field)];
  });
};

/** Plan one compatible optional text addition for the generated Arrusted literal CUE layout. */
export const addOptionalTextField = (source: string, input: OptionalTextField) => {
  const tokens = sourceTokens(source);
  const full = { start: 0, end: tokens.length };
  const expression = property(tokens, full, "manifest");
  if (tokens[expression]?.text !== "#AppManifest" || tokens[expression + 1]?.text !== "&") {
    throw unsupported();
  }
  const manifest = literalRange(tokens, expression + 2, "{", tokens.length);
  const models = literalRange(tokens, property(tokens, manifest, "models"), "[", manifest.end);
  const model = uniqueLiteral(tokens, structList(tokens, models), input.modelId);
  if (quotedValue(tokens[property(tokens, model, "kind")]) !== "entity") {
    throw unsupported();
  }
  const fields = literalRange(tokens, property(tokens, model, "fields"), "[", model.end);
  if (
    structList(tokens, fields).some(
      (field) => quotedValue(tokens[property(tokens, field, "id")]) === input.fieldId,
    )
  ) {
    throw new Error(
      "This optional field already exists. Preserve the existing schema and prepare only the remaining app changes.",
    );
  }
  const version = tokens[property(tokens, manifest, "version")];
  const previous = /^"(?<prefix>[\w.-]+[.-]v)(?<cut>[1-9][0-9]*)"$/u.exec(version?.text ?? "");
  const cut = Number(previous?.groups?.cut);
  const prefix = previous?.groups?.prefix;
  if (prefix === undefined || !Number.isSafeInteger(cut + 1)) {
    throw unsupported();
  }
  const releaseId = `${prefix}${cut + 1}`;
  const edits = [
    { offset: version.offset, length: version.text.length, text: JSON.stringify(releaseId) },
    listInsertion(
      tokens,
      fields,
      `{id: ${JSON.stringify(input.fieldId)}, label: ${JSON.stringify(input.label)}, type: "text", required: false}`,
    ),
    ...changeTypeEdits(tokens, manifest, input),
  ];
  const content = edits
    .toSorted((a, b) => b.offset - a.offset)
    .reduce(
      (current, edit) =>
        current.slice(0, edit.offset) + edit.text + current.slice(edit.offset + edit.length),
      source,
    );
  return { content, releaseId };
};
