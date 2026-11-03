/** Product navigation only; selecting a destination never grants effect authority. */
export const withBuilderDestinationGuidance = <T extends { status: string; code?: string }>(
  result: T,
  sessionId: string,
) => {
  if (result.status !== "blocked") {
    return result;
  }
  if (result.code === "builder_destination_required") {
    const destinationPath = `/builds/${encodeURIComponent(sessionId)}/destination`;
    return {
      ...result,
      destinationPath,
      nextAction: `Choose where to store and release this app at ${destinationPath}. Continue the same saved session and normal Builder destination setup. Keep existing work and pending operations; do not create a replacement session or a separate Preview project. Destination selection does not approve publication or deployment.`,
    };
  }
  if (result.code === "builder_destination_configuration_required") {
    return {
      ...result,
      nextAction:
        "Keep the selected Builder destination. Its same-project Auth and runtime configuration still needs supported setup before release. Report the missing configuration and continue that setup; do not allocate a second project, change the destination, or reuse approval for a different effect.",
    };
  }
  return result;
};
