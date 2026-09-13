import { parseArgs } from "node:util";
import { writeSupplementaryAssessment } from "../evals/support/self-reproduction-supplementary";

const { values } = parseArgs({
  options: {
    "run-dir": { type: "string" },
    "source-review-dir": { type: "string" },
    "output-dir": { type: "string" },
    "reference-captures-dir": { type: "string" },
  },
});
if (!values["run-dir"] || !values["source-review-dir"] || !values["output-dir"])
  throw new Error(
    "Required: --run-dir PATH --source-review-dir PATH --output-dir NEW_EXTERNAL_PATH",
  );
const report = await writeSupplementaryAssessment({
  runDirectory: values["run-dir"],
  sourceReviewDirectory: values["source-review-dir"],
  outputDirectory: values["output-dir"],
  referenceCapturesDirectory: values["reference-captures-dir"],
});
console.log(
  JSON.stringify({
    output: values["output-dir"],
    kind: report.kind,
    rows: report.assessment.rows.length,
    missingEvidence: report.missingEvidence,
  }),
);
