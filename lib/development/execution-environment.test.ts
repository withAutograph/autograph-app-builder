import { describe, expect, it } from "vitest";
import { developmentExecutionEnvironment } from "./execution-environment.mjs";
import { developmentLaunchEnvironment } from "./dev-package";
import { canAutoSelectDevelopmentSource } from "../repository/development-source";

const launch = () =>
  developmentLaunchEnvironment({
    dependencyKey: "dependency",
    destinationRoot: "/destination",
    evePort: 3210,
    fingerprint: "fingerprint",
    snapshotRoot: "/snapshot",
    sourceRoot: "/source",
    sourceSha: "sha",
    sourceTree: "tree",
  });

describe("shared development execution boundary", () => {
  it("makes the normal launcher satisfy source selection without source-specific values in the constant", () => {
    const environment = launch();
    expect(canAutoSelectDevelopmentSource(environment)).toBe(true);
    expect(environment.REPOSITORY_LOCAL_ROOTS).toBe("/snapshot");
    expect(environment.REPOSITORY_WORKSPACE_ROOT).toBe("/destination");
    expect(
      Object.keys(developmentExecutionEnvironment).some((name) =>
        /SOURCE|ROOT|SHA|DIGEST|FINGERPRINT/u.test(name),
      ),
    ).toBe(false);
    expect(Object.isFrozen(developmentExecutionEnvironment)).toBe(true);
  });
  it.each(Object.keys(developmentExecutionEnvironment))(
    "requires existing exact binding %s",
    (name) => {
      const environment = Object.fromEntries(
        Object.entries(launch()).filter(([key]) => key !== name),
      );
      expect(canAutoSelectDevelopmentSource(environment)).toBe(false);
      environment[name] = "unexpected";
      expect(canAutoSelectDevelopmentSource(environment)).toBe(false);
    },
  );
});
