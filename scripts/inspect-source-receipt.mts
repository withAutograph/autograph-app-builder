import {
  inspectSourceReceipt,
  sourceReceiptEvidence,
  type SourceKind,
} from "../lib/repository/source-receipt";

function parseArguments(args: readonly string[]): {
  sourceKind: SourceKind;
  sourcePath: string;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (flag === undefined || value === undefined || !flag.startsWith("--"))
      throw new Error("Arguments must be exact --name value pairs.");
    if (values.has(flag)) throw new Error(`Duplicate argument ${flag}.`);
    values.set(flag, value);
  }
  const sourceKind = values.get("--source-kind");
  const sourcePath = values.get("--source-path");
  values.delete("--source-kind");
  values.delete("--source-path");
  if (sourceKind !== "existing-repository" && sourceKind !== "fresh-template")
    throw new Error(
      "--source-kind must be existing-repository or fresh-template.",
    );
  if (sourcePath === undefined || sourcePath === "")
    throw new Error("--source-path is required.");
  if (values.size !== 0)
    throw new Error(`Unknown arguments: ${[...values.keys()].join(", ")}.`);
  return { sourceKind, sourcePath };
}

const { sourceKind, sourcePath } = parseArguments(process.argv.slice(2));
const receipt = await inspectSourceReceipt(sourceKind, sourcePath);
console.log(JSON.stringify(sourceReceiptEvidence(receipt), null, 2));
