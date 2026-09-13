import { describe, expect, it } from "vitest";
import { assertAcceptedAppSpec } from "./self-reproduction-prerequisites";

describe("self-reproduction artifact prerequisite", () => {
  it.each(["prepared", "ui_previewed", "ui_accepted", "empty"])(
    "stops before downstream mutations after design ends at %s",
    (phase) => {
      expect(() => assertAcceptedAppSpec({ phase })).toThrow("no accepted build-ready AppSpec");
    },
  );
  it.each(["app_spec_accepted", "dependencies_prepared", "planned", "reviewed"])(
    "allows normal accepted-artifact continuation at %s",
    (phase) => {
      expect(() => assertAcceptedAppSpec({ phase })).not.toThrow();
    },
  );
  it("does not infer acceptance from prose or missing status", () => {
    expect(() => assertAcceptedAppSpec("The AppSpec is ready.")).toThrow("unavailable");
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Exercise missing status through the required input argument.
    expect(() => assertAcceptedAppSpec(undefined)).toThrow("unavailable");
  });
});
