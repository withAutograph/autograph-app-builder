import { expect, it } from "vitest";
import { withBuilderDestinationGuidance } from "./builder-destination-guidance";

it("offers the existing session's ordinary destination page without granting an effect", () => {
  const result = withBuilderDestinationGuidance(
    { status: "blocked", code: "builder_destination_required" },
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
    { status: "blocked", code: "builder_destination_configuration_required" },
    "saved-session",
  );
  expect(result).not.toHaveProperty("destinationPath");
  expect(result).toHaveProperty("nextAction", expect.stringContaining("Keep the selected"));
});

it.each([
  { status: "planned" },
  { status: "pending", code: "builder_destination_required" },
  { status: "blocked", code: "authorization_required" },
  { status: "blocked", code: "reconciliation_required" },
])("retains other outcomes without destination guidance (%j)", (result) => {
  expect(withBuilderDestinationGuidance(result, "saved-session")).toBe(result);
});

it("keeps domain ambiguity as a supported selection prerequisite without authorizing release", () => {
  const result = withBuilderDestinationGuidance(
    { status: "blocked", code: "builder_public_domain_selection_required" },
    "saved-session",
  );
  expect(result).toHaveProperty(
    "nextAction",
    expect.stringContaining("one verified production domain"),
  );
  expect(result).not.toHaveProperty("destinationPath");
});
