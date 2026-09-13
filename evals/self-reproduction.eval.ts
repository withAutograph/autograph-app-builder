import { defineEval } from "eve/evals";

/** Retired diagnostic: stage-directed prompts do not measure ordinary Builder use. */
export default defineEval({
  description:
    "Retired guided self-reproduction diagnostic; use the public App Builder entrypoint.",
  tags: ["self-reproduction", "retired-diagnostic"],
  test() {
    throw new Error(
      "Self-reproduction generation requires the public App Builder entrypoint. The guided internal-stage benchmark is retired. Use the ordinary Builder session with the product brief, then --report-only to assess its output.",
    );
  },
});
