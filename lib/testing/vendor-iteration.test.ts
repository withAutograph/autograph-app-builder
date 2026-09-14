import { describe, expect, it } from "vitest";

import { addVendorTaxVerificationStatus, selectVendorReviewSourcePath } from "./vendor-iteration";

describe("Vendor iteration fixture", () => {
  it("selects the app-owned review UI instead of an unrelated route page", () => {
    expect(
      selectVendorReviewSourcePath([
        "apps/vendor/app/vendor/data-import/page.tsx",
        "apps/vendor/app/vendor/review-queue/page.tsx",
        "apps/vendor/frontend/src/review/ReviewQueueServerPage.tsx",
      ]),
    ).toBe("apps/vendor/frontend/src/review/ReviewQueueServerPage.tsx");
  });

  it("adds the requested status to the current review component root", () => {
    const [change] = addVendorTaxVerificationStatus([
      {
        content: `export function ReviewQueueServerPage() {
  return (
    <main className="vendor-review-page">
      <h1>Data Review</h1>
    </main>
  );
}`,
        path: "apps/vendor/frontend/src/review/ReviewQueueServerPage.tsx",
      },
    ]);

    expect(change?.content).toContain(
      '<main className="vendor-review-page">\n<p data-vendor-review-status="tax-verification">Tax verification required</p>',
    );
  });
});
