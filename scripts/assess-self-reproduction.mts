import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
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
if (!values["output-dir"]) {throw new Error("Supply an external --output-dir for parity artifacts.");}
const output = path.resolve(values["output-dir"]);
await mkdir(output, { mode: 0o700, recursive: true });
await writeFile(
  path.resolve(output, "parity-evidence.schema.json"),
  JSON.stringify(z.toJSONSchema(parityEvidenceSchema), null, 2),
);
await writeFile(
  path.resolve(output, "parity-assessment.schema.json"),
  JSON.stringify(z.toJSONSchema(parityAssessmentSchema), null, 2),
);
await writeFile(
  path.resolve(output, "parity-matrix.json"),
  JSON.stringify({ desktopViewports, requirements, workflowMatrix }, null, 2),
);
if (!values["schema-only"]) {
  if (!values.evidence)
    {throw new Error(
      "Supply evaluator-owned --evidence; candidate workflow-results files are not trusted.",
    );}
  const evidencePath = path.resolve(values.evidence);
  const evidenceRoot = await realpath(path.dirname(evidencePath));
  const report = await assessParity(
    JSON.parse(await readFile(evidencePath, "utf-8")),
    async (candidatePath) => {
      try {
        const file = await realpath(path.resolve(evidenceRoot, candidatePath));
        const rel = path.relative(evidenceRoot, file);
        if (path.isAbsolute(rel) || rel === ".." || rel.startsWith("../")) {return false;}
        const info = await stat(file);
        return info.isFile() && info.size > 0;
      } catch {
        return false;
      }
    },
  );
  await writeFile(
    path.resolve(output, "parity-assessment.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(`Parity assessment: ${path.resolve(output, "parity-assessment.json")}`);
}
