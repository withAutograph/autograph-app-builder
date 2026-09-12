import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import {
  assessParity,
  parityEvidenceSchema,
  parityAssessmentSchema,
  requirements,
  workflowMatrix,
  desktopViewports,
} from "../evals/support/self-reproduction-parity";

const { values } = parseArgs({
  options: {
    evidence: { type: "string" },
    "output-dir": { type: "string" },
    "schema-only": { type: "boolean" },
  },
});
if (!values["output-dir"]) throw new Error("Supply an external --output-dir for parity artifacts.");
const output = resolve(values["output-dir"]);
await mkdir(output, { recursive: true, mode: 0o700 });
await writeFile(
  resolve(output, "parity-evidence.schema.json"),
  JSON.stringify(z.toJSONSchema(parityEvidenceSchema), null, 2),
);
await writeFile(
  resolve(output, "parity-assessment.schema.json"),
  JSON.stringify(z.toJSONSchema(parityAssessmentSchema), null, 2),
);
await writeFile(
  resolve(output, "parity-matrix.json"),
  JSON.stringify({ requirements, workflowMatrix, desktopViewports }, null, 2),
);
if (!values["schema-only"]) {
  if (!values.evidence)
    throw new Error(
      "Supply evaluator-owned --evidence; candidate workflow-results files are not trusted.",
    );
  const evidencePath = resolve(values.evidence);
  const evidenceRoot = await realpath(dirname(evidencePath));
  const report = await assessParity(
    JSON.parse(await readFile(evidencePath, "utf8")),
    async (path) => {
      try {
        const file = await realpath(resolve(evidenceRoot, path));
        const rel = relative(evidenceRoot, file);
        if (isAbsolute(rel) || rel === ".." || rel.startsWith("../")) return false;
        const info = await stat(file);
        return info.isFile() && info.size > 0;
      } catch {
        return false;
      }
    },
  );
  await writeFile(
    resolve(output, "parity-assessment.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Parity assessment: ${resolve(output, "parity-assessment.json")}`);
}
