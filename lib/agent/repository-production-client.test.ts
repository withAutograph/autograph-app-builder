import { describe, expect, it } from "vitest";
import { repositoryProductionResponseError } from "./repository-production-client";

describe("Production request failure guidance", () => {
  it.each(["plan", "setup-status"] as const)(
    "does not claim %s provisioned anything",
    async (action) => {
      const error = await repositoryProductionResponseError(
        Response.json({ code: "app_access_unknown" }, { status: 503 }),
        action,
      );
      expect(error.message).toContain("This read did not start setup");
      expect(error.message).not.toContain("setup is saved");
    },
  );
  it("retains uncertainty for an unconfirmed preparation", async () => {
    const error = await repositoryProductionResponseError(
      new Response("unavailable", { status: 503 }),
      "prepare",
    );
    expect(error.message).toContain("Check its status before retrying");
  });
  it("guides recovery of the saved delivery in the same session", async () => {
    const error = await repositoryProductionResponseError(
      Response.json(
        { code: "app_setup_destination_required", secret: "never expose" },
        { status: 409 },
      ),
      "plan",
    );
    expect(error.message).toContain("saved delivery in the same session");
    expect(error.message).toContain("repository and current source for Production");
    expect(error.message).not.toContain("never expose");
  });
});
