import type { AcceptedAppSpec } from "./workflow-state";

/** Retain product outcomes independently of successful compiler/test commands. */
export const productAcceptanceObligations = (
  appSpec: Pick<AcceptedAppSpec, "content" | "digest">,
  evidence: readonly unknown[] = [],
) => {
  const lines = appSpec.content.split(/\r?\n/u);
  const selected: string[] = [];
  let inWalkthrough = false;
  let fence: string | undefined;
  for (const line of lines) {
    const marker = /^\s*(?<marker>```+|~~~+)/u.exec(line)?.groups?.marker;
    if (marker) {
      if (fence === undefined) {fence = marker.charAt(0);}
      else if (marker.charAt(0) === fence) {fence = undefined;}
    }
    if (fence === undefined && /^##\s+/u.test(line)) {
      if (inWalkthrough) {break;}
      inWalkthrough = /^##\s+Acceptance walkthrough\s*$/iu.test(line);
      continue;
    }
    if (inWalkthrough) {selected.push(line);}
  }
  const walkthrough = selected.join("\n").trim();
  return {
    appSpecDigest: appSpec.digest,
    evidence,
    implementationPrompt: walkthrough
      ? `Implement the accepted product outcomes below, including their real data and execution paths. For each outcome, identify the user action, the actual application operation, and an independent observable readback. Preserve these scenarios in executable behavioral tests. Prototype state transitions and passing repository commands do not establish product completion.\n\n${walkthrough}`
      : "The accepted specification contains no executable acceptance walkthrough. Product behavior remains unassessed; repository command success alone does not establish completion.",
    productStatus: "unassessed" as const,
    reason:
      "Repository validation establishes technical checks only. Product outcomes require executed action and independent readback evidence.",
    walkthrough,
  };
};
