import { describe, expect, it } from "vitest";

import { developmentInspectionPath } from "./source-routing";

describe("development source routing", () => {
  const environment = {
    APP_BUILDER_EXECUTION_MODE: "development",
    APP_BUILDER_DEVELOPMENT_SOURCE_ROOT: "/private/user/arrusted",
    APP_BUILDER_DEVELOPMENT_SNAPSHOT_ROOT: "/private/run/source",
  };

  it("routes the named development checkout to its immutable snapshot", () => {
    expect(
      developmentInspectionPath({
        requestedPath: "/private/user/arrusted",
        environment,
      }),
    ).toBe("/private/run/source");
  });

  it("does not grant arbitrary paths snapshot authority", () => {
    expect(
      developmentInspectionPath({
        requestedPath: "/private/user/outside",
        environment,
      }),
    ).toBe("/private/user/outside");
  });
});
