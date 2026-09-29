import { describe, expect, it } from "vitest";
import { assertInitialAppBaseline } from "./app-baseline-state";
import type { AppBaselineSelection } from "../repository/app-baseline";
/* oxlint-disable sonarjs/no-undefined-assignment -- Exercise the explicit absent saved selection and omitted request. */

const selection: AppBaselineSelection = {
  appId: "spend-review",
  historical: {
    commitSha: "a".repeat(40),
    name: "arrusted",
    owner: "example",
    repositoryId: "100",
    treeSha: "b".repeat(40),
  },
  selectedByCallId: "source-choice",
  sessionId: "session-one",
  source: { commitSha: "a".repeat(40), kind: "commit" },
};
const requested = { appId: selection.appId, source: selection.source };
describe("initial app baseline selection", () => {
  it("allows an initial selection and exact pending recovery after source preparation", () => {
    const input = { occupied: false, repository: "example/arrusted", requested, saved: undefined };
    expect(() => {
      assertInitialAppBaseline(input);
    }).not.toThrow();
    expect(() => {
      assertInitialAppBaseline({ ...input, occupied: true, saved: { selection } });
    }).not.toThrow();
    expect(() => {
      assertInitialAppBaseline({
        ...input,
        occupied: true,
        requested: undefined,
        saved: { selection },
      });
    }).not.toThrow();
  });
  it("rejects baseline replacement in an occupied session and permits ordinary source selection", () => {
    const input = { occupied: true, repository: "example/arrusted", requested, saved: undefined };
    expect(() => {
      assertInitialAppBaseline(input);
    }).toThrow("occupied source will not be replaced");
    expect(() => {
      assertInitialAppBaseline({ ...input, requested: undefined });
    }).not.toThrow();
    expect(() => {
      assertInitialAppBaseline({ ...input, repository: "other/arrusted", saved: { selection } });
    }).toThrow("different app baseline");
    expect(() => {
      assertInitialAppBaseline({
        ...input,
        requested: { ...requested, appId: "other-app" },
        saved: { selection },
      });
    }).toThrow("different app baseline");
  });
});
