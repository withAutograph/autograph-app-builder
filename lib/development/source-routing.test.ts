import { describe, expect, it } from "vitest";

import { developmentInspectionPath } from "./source-routing";

describe("development source routing", () => {
  const environment = {
    APP_BUILDER_DEVELOPMENT_SNAPSHOT_ROOT: "/private/run/source",
    APP_BUILDER_DEVELOPMENT_SOURCE_ROOT: "/private/user/arrusted",
    APP_BUILDER_EXECUTION_MODE: "development",
  };

  it("routes the named development checkout to its immutable snapshot", () => {
    expect(
      developmentInspectionPath({
        environment,
        requestedPath: "/private/user/arrusted",
      })
    ).toBe("/private/run/source");
  });

  it("does not grant arbitrary paths snapshot authority", () => {
    expect(
      developmentInspectionPath({
        environment,
        requestedPath: "/private/user/outside",
      })
    ).toBe("/private/user/outside");
  });
});
