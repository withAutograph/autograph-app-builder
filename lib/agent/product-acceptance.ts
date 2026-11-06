import type { ProductSourceAssessment } from "./product-source-review";
import type { AcceptedAppSpec } from "./workflow-state";

const acceptanceWalkthroughFromContent = (content: string | undefined) => {
  const lines = content?.split(/\r?\n/u) ?? [];
  const selected: string[] = [];
  let inWalkthrough = false;
  let fence: string | null = null;
  for (const line of lines) {
    const marker = /^\s*(?<marker>```+|~~~+)/u.exec(line)?.groups?.marker;
    if (marker !== undefined && marker.length > 0) {
      if (fence === null) {
        fence = marker.charAt(0);
      } else if (marker.startsWith(fence)) {
        fence = null;
      }
    }
    const isLevelTwoHeading = fence === null && line.startsWith("##") && /\s/u.test(line[2] ?? "");
    if (isLevelTwoHeading) {
      inWalkthrough = !inWalkthrough && /^##\s+Acceptance walkthrough\s*$/iu.test(line);
    } else if (inWalkthrough) {
      selected.push(line);
    }
  }
  return selected.join("\n").trim();
};

/** Retain product outcomes independently of successful compiler/test commands. */
export const productAcceptanceObligations = (
  appSpec: Pick<AcceptedAppSpec, "content" | "digest" | "walkthrough">,
  evidence: readonly unknown[] = [],
  sourceAssessment?: ProductSourceAssessment,
) => {
  const walkthrough = appSpec.walkthrough ?? acceptanceWalkthroughFromContent(appSpec.content);
  return {
    appSpecDigest: appSpec.digest,
    evidence,
    implementationPrompt: walkthrough
      ? `Implement the accepted product outcomes below, including their real data and execution paths. For each outcome, identify the user action, the actual application operation, and an independent observable readback. Preserve these scenarios in executable behavioral tests. Prototype state transitions and passing repository commands do not establish product completion.\n\n${walkthrough}`
      : "The accepted specification contains no executable acceptance walkthrough. Product behavior remains unassessed; repository command success alone does not establish completion.",
    productStatus:
      sourceAssessment?.status === "failed" ? ("failed" as const) : ("unassessed" as const),
    reason:
      "Repository validation establishes technical checks only. Product outcomes require executed action and independent readback evidence.",
    sourceAssessment,
    walkthrough,
  };
};
