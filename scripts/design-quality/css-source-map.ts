export type CssSourceMap = {
  version: number;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  mappings: string;
};

const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeVlq(value: string, start: number) {
  let result = 0;
  let shift = 0;
  let index = start;
  while (index < value.length) {
    const digit = base64.indexOf(value[index]!);
    if (digit === -1) return undefined;
    index += 1;
    result += (digit & 31) << shift;
    shift += 5;
    if (!(digit & 32)) return { value: result & 1 ? -(result >> 1) : result >> 1, index };
  }
  return undefined;
}

/**
 * Return the original CSS source for the generated declaration position. This
 * follows the source-map's greatest-lower-bound rule, so an unmapped line is
 * never guessed from a nearby line.
 */
export function originalCssSource(
  map: CssSourceMap,
  generatedLine: number,
  generatedColumn: number,
) {
  if (
    map.version !== 3 ||
    generatedLine < 0 ||
    generatedColumn < 0 ||
    !Array.isArray(map.sources) ||
    !map.sources.every((source) => typeof source === "string") ||
    (map.sourceRoot !== undefined && typeof map.sourceRoot !== "string")
  )
    return undefined;
  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  const lines = map.mappings.split(";");
  for (let line = 0; line <= generatedLine; line += 1) {
    let generated = 0;
    const segments = lines[line]?.split(",") ?? [];
    let candidate: { source: number; originalLine: number; originalColumn: number } | undefined;
    for (const segment of segments) {
      const fields: number[] = [];
      let index = 0;
      while (index < segment.length) {
        const decoded = decodeVlq(segment, index);
        if (!decoded) return undefined;
        fields.push(decoded.value);
        ({ index } = decoded);
      }
      if (!fields.length) continue;
      generated += fields[0]!;
      // A one-field segment is an explicit unmapped span. It must not inherit
      // the preceding segment's source merely because this lookup is later on
      // the same generated line.
      if (fields.length === 1) {
        if (line === generatedLine && generated <= generatedColumn) candidate = undefined;
        continue;
      }
      if (fields.length !== 4 && fields.length !== 5) return undefined;
      source += fields[1]!;
      originalLine += fields[2]!;
      originalColumn += fields[3]!;
      if (line === generatedLine && generated <= generatedColumn)
        candidate = { source, originalLine, originalColumn };
    }
    if (line === generatedLine && candidate) {
      const path = map.sources[candidate.source];
      if (typeof path !== "string" || !path) return undefined;
      return {
        path: map.sourceRoot
          ? `${map.sourceRoot.replace(/\/$/u, "")}/${path.replace(/^\//u, "")}`
          : path,
        line: candidate.originalLine + 1,
        column: candidate.originalColumn + 1,
        sourceIndex: candidate.source,
      };
    }
  }
  return undefined;
}
