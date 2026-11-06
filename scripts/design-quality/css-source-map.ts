export interface CssSourceMap {
  version: number;
  sourceRoot?: string;
  sources: string[];
  sourcesContent?: (string | null)[];
  mappings: string;
}

const base64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

type DecodedVlq = { index: number; value: number } | null;

function decodeVlq(encodedValue: string, start: number): DecodedVlq {
  let result = 0;
  let shift = 0;
  let index = start;
  while (index < encodedValue.length) {
    const digit = base64.indexOf(encodedValue.charAt(index));
    if (digit === -1) {
      return null;
    }
    index += 1;
    result += (digit % 32) * 2 ** shift;
    shift += 5;
    if (digit < 32) {
      const decodedValue = Math.floor(result / 2);
      return { index, value: result % 2 === 1 ? -decodedValue : decodedValue };
    }
  }
  return null;
}

const isCssSourceMap = (map: CssSourceMap): boolean =>
  map.version === 3 && Array.isArray(map.sources) && map.sourceRoot !== null;

type SegmentFields = number[] | null;

const decodeSegment = (segment: string): SegmentFields => {
  const fields: number[] = [];
  let index = 0;
  while (index < segment.length) {
    const decoded = decodeVlq(segment, index);
    if (decoded === null) {
      return null;
    }
    fields.push(decoded.value);
    ({ index } = decoded);
  }
  return fields;
};

interface Candidate {
  source: number;
  originalLine: number;
  originalColumn: number;
}
const isMappedSegment = (fields: number[]): boolean => fields.length === 4 || fields.length === 5;

interface ParsedMappingLine {
  source: number;
  originalLine: number;
  originalColumn: number;
  candidate: Candidate | null;
}

const parseMappingLine = (
  mapping: string,
  targetColumn: number,
  initialSource: number,
  initialOriginalLine: number,
  initialOriginalColumn: number,
): ParsedMappingLine | null => {
  let source = initialSource;
  let originalLine = initialOriginalLine;
  let originalColumn = initialOriginalColumn;
  let generated = 0;
  let candidate: Candidate | null = null;
  for (const segment of mapping.split(",")) {
    const fields = decodeSegment(segment);
    if (fields === null) {
      return null;
    }
    if (fields.length === 0) {
      continue;
    }
    const [generatedDelta, sourceDelta, lineDelta, columnDelta] = fields;
    if (generatedDelta === undefined) {
      return null;
    }
    generated += generatedDelta;
    const eligible = generated <= targetColumn;
    if (fields.length === 1) {
      if (eligible) {
        candidate = null;
      }
    } else {
      if (
        !isMappedSegment(fields) ||
        sourceDelta === undefined ||
        lineDelta === undefined ||
        columnDelta === undefined
      ) {
        return null;
      }
      source += sourceDelta;
      originalLine += lineDelta;
      originalColumn += columnDelta;
      if (eligible) {
        candidate = { originalColumn, originalLine, source };
      }
    }
  }
  return { candidate, originalColumn, originalLine, source };
};

const sourcePath = (map: CssSourceMap, sourceIndex: number): string | null => {
  const { sources, sourceRoot } = map;
  const [path] = sources.slice(sourceIndex, sourceIndex + 1);
  if (path === undefined || path.length === 0) {
    return null;
  }
  return sourceRoot === undefined || sourceRoot.length === 0
    ? path
    : `${sourceRoot.replace(/\/$/u, "")}/${path.replace(/^\//u, "")}`;
};

/**
 * Return the original CSS source for the generated declaration position. This
 * follows the source-map's greatest-lower-bound rule, so an unmapped line is
 * never guessed from a nearby line.
 */
export function originalCssSource(
  map: CssSourceMap,
  generatedLine: number,
  generatedColumn: number,
): { column: number; line: number; path: string; sourceIndex: number } | null {
  if (!isCssSourceMap(map) || generatedLine < 0 || generatedColumn < 0) {
    return null;
  }

  let source = 0;
  let originalLine = 0;
  let originalColumn = 0;
  const lines = map.mappings.split(";");
  for (let line = 0; line <= generatedLine; line += 1) {
    const parsed = parseMappingLine(
      lines[line] ?? "",
      generatedColumn,
      source,
      originalLine,
      originalColumn,
    );
    if (parsed === null) {
      return null;
    }
    ({ source, originalLine, originalColumn } = parsed);
    if (line === generatedLine && parsed.candidate !== null) {
      const { candidate } = parsed;
      const path = sourcePath(map, candidate.source);
      if (path === null) {
        return null;
      }
      return {
        column: candidate.originalColumn + 1,
        line: candidate.originalLine + 1,
        path,
        sourceIndex: candidate.source,
      };
    }
  }
  return null;
}
