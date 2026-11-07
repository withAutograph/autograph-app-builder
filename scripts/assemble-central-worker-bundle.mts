import { assembleCentralWorkerBundle } from "../lib/repository/central-worker-bundle";

const values = new Map<string, string>();
const args = process.argv.slice(2);
const flags = [
  "--source-root",
  "--artifact-root",
  "--destination",
  "--reviewed-source-sha",
  "--receipt-sha256",
];
for (let index = 0; index < args.length; index += 2) {
  const flag = args[index];
  const value = args[index + 1];
  if (!flag || !value || !flags.includes(flag) || values.has(flag)) {
    throw new Error("Expected unique supported --name value pairs");
  }
  values.set(flag, value);
}
if (flags.some((flag) => !values.has(flag))) {
  throw new Error(`Required: ${flags.join(", ")}`);
}
const required = (flag: string) => {
  const value = values.get(flag);
  if (value === undefined) {
    throw new Error(`Missing ${flag}`);
  }
  return value;
};
console.log(
  JSON.stringify(
    await assembleCentralWorkerBundle({
      artifactRoot: required("--artifact-root"),
      destination: required("--destination"),
      receiptSha256: required("--receipt-sha256"),
      reviewedSourceSha: required("--reviewed-source-sha"),
      sourceRoot: required("--source-root"),
    }),
  ),
);
