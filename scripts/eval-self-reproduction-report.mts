import { parseArgs } from "node:util";
import { writeSupplementaryAssessment } from "../evals/support/self-reproduction-supplementary";

const { values } = parseArgs({
  options: {
    "output-dir": { type: "string" },
    "reference-captures-dir": { type: "string" },
    "reference-run-dir": { type: "string" },
    "run-dir": { type: "string" },
    "source-review-dir": { type: "string" },
  },
});
if (!values["run-dir"] || !values["source-review-dir"] || !values["output-dir"])
  throw new Error(
    "Required: --run-dir PATH --source-review-dir PATH --output-dir NEW_EXTERNAL_PATH",
  );
const report = await writeSupplementaryAssessment({
  outputDirectory: values["output-dir"],
  referenceCapturesDirectory: values["reference-captures-dir"],
  referenceRunDirectory: values["reference-run-dir"],
  runDirectory: values["run-dir"],
  sourceReviewDirectory: values["source-review-dir"],
});
console.log(
  JSON.stringify({
    kind: report.kind,
    missingEvidence: report.missingEvidence,
    output: values["output-dir"],
    rows: report.assessment.rows.length,
  }),
);
