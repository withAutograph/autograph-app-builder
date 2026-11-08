import { describe, expect, it } from "vitest";
import { navigationReporterOptions } from "./self-reproduction-navigation-command";

describe("production navigation reporter command", () => {
  it("forwards exact JSON path through the deliberately restricted child environment", () => {
    expect(
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises navigation reporter argument forwarding.
      navigationReporterOptions(["--json-report", "/tmp/run evidence/report.json", "--workers=1"]),
    ).toEqual({
      args: ["--workers=1", "--reporter=list,json"],
      // oxlint-disable-next-line sonarjs/publicly-writable-directories -- Fixture path exercises navigation reporter argument forwarding.
      environment: { PLAYWRIGHT_JSON_OUTPUT_FILE: "/tmp/run evidence/report.json" },
    });
  });
  it("preserves ordinary test invocation and rejects incomplete output paths", () => {
    expect(navigationReporterOptions(["--grep=sign-in"])).toEqual({
      args: ["--grep=sign-in"],
      environment: {},
    });
    expect(() => navigationReporterOptions(["--json-report"])).toThrow("absolute output path");
    expect(() => navigationReporterOptions(["--json-report", "relative.json"])).toThrow(
      "absolute output path",
    );
  });
});
