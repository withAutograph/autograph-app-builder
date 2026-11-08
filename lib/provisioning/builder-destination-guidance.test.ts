import { expect, it } from "vitest";
import { withBuilderDestinationGuidance } from "./builder-destination-guidance";

it("offers the existing session's ordinary destination page without granting an effect", () => {
  const result = withBuilderDestinationGuidance(
    { code: "builder_destination_required", status: "blocked" },
    "saved/session?fragment#",
  );
  expect(result).toMatchObject({
    code: "builder_destination_required",
    destinationPath: "/builds/saved%2Fsession%3Ffragment%23/destination",
    status: "blocked",
  });
  expect(result).toHaveProperty("nextAction", expect.stringContaining("does not approve"));
});

it("keeps the selected destination when only runtime configuration is missing", () => {
  const result = withBuilderDestinationGuidance(
    { code: "builder_destination_configuration_required", status: "blocked" },
    "saved-session",
  );
  expect(result).not.toHaveProperty("destinationPath");
  expect(result).toHaveProperty("nextAction", expect.stringContaining("Keep the selected"));
});

it.each([
  { status: "planned" },
  { code: "builder_destination_required", status: "pending" },
  { code: "authorization_required", status: "blocked" },
  { code: "reconciliation_required", status: "blocked" },
])("retains other outcomes without destination guidance (%j)", (result) => {
  expect(withBuilderDestinationGuidance(result, "saved-session")).toBe(result);
});

it("keeps domain ambiguity as a supported selection prerequisite without authorizing release", () => {
  const result = withBuilderDestinationGuidance(
    { code: "builder_public_domain_selection_required", status: "blocked" },
    "saved-session",
  );
  expect(result).toHaveProperty(
    "nextAction",
    expect.stringContaining("one verified production domain"),
  );
  expect(result).not.toHaveProperty("destinationPath");
});
