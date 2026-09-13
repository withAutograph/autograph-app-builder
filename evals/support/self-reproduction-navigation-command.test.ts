import { describe, expect, it } from "vitest";
import {
  navigationDatabaseOptions,
  navigationReporterOptions,
} from "./self-reproduction-navigation-command";

describe("production navigation reporter command", () => {
  it("forwards exact JSON path through the deliberately restricted child environment", () => {
    expect(
      navigationReporterOptions(["--json-report", "/tmp/run evidence/report.json", "--workers=1"]),
    ).toEqual({
      args: ["--workers=1", "--reporter=list,json"],
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

describe("production navigation database command", () => {
  it("selects process PostgreSQL without Docker and preserves reporter arguments", () => {
    expect(
      navigationDatabaseOptions([
        "--json-report",
        "/tmp/report.json",
        "--postgres-backend",
        "process",
      ]),
    ).toEqual({
      args: ["--json-report", "/tmp/report.json"],
      backend: "process",
      docker: undefined,
      dockerHost: undefined,
    });
  });
  it("preserves the existing Docker default and exact connection arguments", () => {
    expect(
      navigationDatabaseOptions([
        "--docker",
        "/opt/bin/docker",
        "--docker-host",
        "unix:///tmp/docker.sock",
        "--grep=sign-in",
      ]),
    ).toEqual({
      args: ["--grep=sign-in"],
      backend: "docker",
      docker: "/opt/bin/docker",
      dockerHost: "unix:///tmp/docker.sock",
    });
  });
  it("rejects malformed backend selection before executing setup", () => {
    expect(() => navigationDatabaseOptions(["--postgres-backend"])).toThrow("Missing");
    expect(() => navigationDatabaseOptions(["--postgres-backend", "other"])).toThrow("Invalid");
    expect(() =>
      navigationDatabaseOptions(["--postgres-backend", "process", "--postgres-backend", "docker"]),
    ).toThrow("Duplicate");
    expect(() => navigationDatabaseOptions([])).toThrow("mise run");
  });
});
