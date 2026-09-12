import { expect, test } from "playwright/test";

import { finishOAuth, resetApplicationState, waitForBuilderReady } from "../support/harness";

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test callback
test.beforeEach(async () => resetApplicationState());

test("editing and autosave never start a view transition around the live form", async ({
  page,
}) => {
  await finishOAuth(page, "GitHub");
  await page.goto("/");
  await waitForBuilderReady(page);
  await page.evaluate(() => {
    const nativeStart = document.startViewTransition.bind(document);
    document.documentElement.dataset.builderEditTransitions = "0";
    document.startViewTransition = (options) => {
      const input = document.querySelector<HTMLInputElement>("#app-name");
      if (input && !input.matches(":disabled")) {
        const count = Number(document.documentElement.dataset.builderEditTransitions);
        document.documentElement.dataset.builderEditTransitions = String(count + 1);
      }
      return nativeStart(options);
    };
  });

  for (const [label, value] of [
    ["App Name", "Uninterrupted Draft"],
    ["App Brief", "Keep both edits through autosave."],
  ]) {
    // Do not let the previous edit's Saved status satisfy this checkpoint.
    const saved = page.waitForResponse((response) => {
      const request = response.request();
      const body = request.postData();
      return (
        request.method() === "POST" &&
        Boolean(request.headers()["next-action"]) &&
        Boolean(body?.includes("clientMutationId") && body.includes(JSON.stringify(value)))
      );
    });
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    await page.getByLabel(label, { exact: true }).fill(value);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const response = await saved;
    expect(response.ok()).toBe(true);
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    await response.finished();
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    await expect(page.getByRole("status")).toHaveText("Draft saved");
  }
  // Observe the real browser API, without disabling animations in the test or
  // waiting out a race before each edit. Live form updates must not mute input.
  await expect(page.locator("html")).toHaveAttribute("data-builder-edit-transitions", "0");

  await page.reload();
  await waitForBuilderReady(page);
  await expect(page.getByLabel("App Name")).toHaveValue("Uninterrupted Draft");
  await expect(page.getByLabel("App Brief", { exact: true })).toHaveValue(
    "Keep both edits through autosave.",
  );
});
