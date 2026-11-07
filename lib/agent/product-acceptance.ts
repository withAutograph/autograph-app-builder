import type { ProductSourceAssessment } from "./product-source-review";
import type { AcceptedAppSpec } from "./workflow-state";

const nextFence = (line: string, fence: string | null): string | null => {
  const marker = /^\s*(?<marker>```+|~~~+)/u.exec(line)?.groups?.marker;
  if (marker === undefined || marker === "") return fence;
  if (fence === null) return marker.charAt(0);
  return marker.startsWith(fence) ? null : fence;
};

const acceptanceWalkthroughFromContent = (content: string | undefined) => {
  const selected: string[] = [];
  let inWalkthrough = false;
  let fence: string | null = null;
  for (const line of content?.split(/\r?\n/u) ?? []) {
    fence = nextFence(line, fence);
    const isHeading = fence === null && line.startsWith("##") && /\s/u.test(line[2] ?? "");
    if (isHeading) {
      if (inWalkthrough) {
        break;
      }
      inWalkthrough = /^##\s+Acceptance walkthrough\s*$/iu.test(line);
    }
    if (!isHeading && inWalkthrough) {
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
  const contentWalkthrough = acceptanceWalkthroughFromContent(appSpec.content);
  const walkthrough = appSpec.walkthrough ?? contentWalkthrough;
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
