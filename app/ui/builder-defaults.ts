export const defaultBrief =
  "# Product\n\nBuild a focused app that helps people complete one important workflow. Define the users, the desired outcome, the repository constraints, and the acceptance criteria. Match the requested product tone and interface, verify assumptions before building, and make the final checks explicit.";

export const briefExamples = [
  defaultBrief,
  "# Customer feedback portal\n\nBuild a portal where customers can submit feedback, vote on ideas, and follow status updates. Give the product team a triage view with tags, ownership, and clear acceptance criteria.",
  "# Operations dashboard\n\nBuild an internal dashboard for monitoring active work, blocked tasks, and service health. Prioritize fast scanning, clear ownership, and links to the source systems for follow-up.",
  "# Vendor onboarding\n\nBuild a guided vendor onboarding app that collects company details, validates required documents, and shows approval progress. Include explicit review states, responsible owners, and audit-friendly history.",
] as const;

const randomNameAdjectives = [
  "Adaptive",
  "Agile",
  "Bright",
  "Calm",
  "Clever",
  "Clear",
  "Curious",
  "Focused",
  "Grounded",
  "Guided",
  "Helpful",
  "Human",
  "Intentional",
  "Keen",
  "Lucid",
  "Modern",
  "Nimble",
  "Open",
  "Ready",
  "Reliable",
  "Simple",
  "Steady",
  "Swift",
  "Thoughtful",
  "Trusted",
  "Useful",
  "Warm",
] as const;
const randomNameNouns = [
  "App",
  "Atlas",
  "Beacon",
  "Blueprint",
  "Bridge",
  "Builder",
  "Canvas",
  "Compass",
  "Forge",
  "Foundry",
  "Flow",
  "Grove",
  "Harbor",
  "Launch",
  "Loom",
  "Orbit",
  "Path",
  "Pilot",
  "Portal",
  "Prism",
  "Relay",
  "Signal",
  "Spark",
  "Stack",
  "Studio",
  "Thread",
  "Waypoint",
  "Workshop",
] as const;

export function repositoryNameFromAppName(appName: string) {
  return appName
    .normalize("NFKD")
    .replaceAll(/[\u0300-\u036F]/gu, "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "")
    .slice(0, 100)
    .replaceAll(/-+$/gu, "");
}

export function appNameFromBrief(brief: string) {
  const firstContentLine = brief
    .split("\n")
    .map((line) => line.replace(/^\s*#+\s*/u, "").trim())
    .find(Boolean);
  if (!firstContentLine) {
    return "";
  }

  const words = firstContentLine
    .replaceAll(/[*_`[\](){}]/gu, " ")
    .replace(/^(?:build|create|design|launch|make)\s+(?:an?\s+|the\s+)?/iu, "")
    .replaceAll(/[^\p{L}\p{N}'& -]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .slice(0, 5);
  return words
    .map((word) =>
      word.length > 1
        ? `${word[0]?.toUpperCase()}${word.slice(1).toLowerCase()}`
        : word.toUpperCase(),
    )
    .join(" ")
    .slice(0, 120)
    .replace(/[\uD800-\uDBFF]$/u, "")
    .trimEnd();
}

export function randomAppName(seed?: string) {
  if (!seed) {
    const adjective = randomNameAdjectives[Math.floor(Math.random() * randomNameAdjectives.length)];
    const noun = randomNameNouns[Math.floor(Math.random() * randomNameNouns.length)];
    return `${adjective} ${noun}`;
  }
  const hash = [...seed].reduce(
    (value, character) => (value * 31 + (character.codePointAt(0) ?? 0)) >>> 0,
    0,
  );
  const adjective = randomNameAdjectives[hash % randomNameAdjectives.length];
  const noun =
    randomNameNouns[Math.floor(hash / randomNameAdjectives.length) % randomNameNouns.length];
  return `${adjective} ${noun}`;
}
