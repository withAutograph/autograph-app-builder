import { describe, expect, it } from "vitest";

import { assertExistingAppSourceSelected } from "./existing-app-source";

describe("existing-app source selection", () => {
  it("requires a selected GitHub source before hosted inspection", () => {
    expect(() => {
      assertExistingAppSourceSelected({ development: false, githubSourceSelected: false });
    }).toThrow("resolve_github_source");
  });

  it("accepts a selected hosted repository", () => {
    expect(() => {
      assertExistingAppSourceSelected({ development: false, githubSourceSelected: true });
    }).not.toThrow();
  });

  it("retains the configured local development source", () => {
    expect(() => {
      assertExistingAppSourceSelected({ development: true, githubSourceSelected: false });
    }).not.toThrow();
  });
});
