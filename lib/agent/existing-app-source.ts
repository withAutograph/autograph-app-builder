/** Keep hosted existing-app inspection on its selected GitHub checkout. */
export const assertExistingAppSourceSelected = function assertExistingAppSourceSelected(input: {
  development: boolean;
  githubSourceSelected: boolean;
}): void {
  if (!input.development && !input.githubSourceSelected) {
    throw new Error(
      "Select the existing GitHub repository with resolve_github_source before inspecting its application.",
    );
  }
};
