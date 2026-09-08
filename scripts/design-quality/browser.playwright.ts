import { expect, test } from "playwright/test";
import { measurePage, measureStyles } from "./browser";

// Authored calibration candidates, not human-validated aesthetic gold labels.
test("measurements distinguish concrete defects from intentional layout", async ({
  page,
}) => {
  await page.addInitScript("globalThis.__name = (value) => value;");
  await page.goto("about:blank");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(
    `<!doctype html><html lang="en"><title>Good reference</title><main><h1>Inventory</h1><label>Location<select><option>All</option></select></label><div style="width:200px;overflow:auto"><table style="width:500px"><thead><tr><th>Item</th><th>Quantity</th></tr></thead><tbody><tr><td>Bottle</td><td>8</td></tr></tbody></table></div><button>Request stock</button></main></html>`,
  );
  const good = await measurePage(page);
  expect(
    good.findings.filter(
      (f) =>
        f.kind === "document-overflow" ||
        f.kind === "possible-column-misalignment",
    ),
  ).toEqual([]);
  expect(good.intentionalScrollContainers.length).toBeGreaterThan(0);
  expect(
    good.accessibility.violations.some((v) => v.id === "button-name"),
  ).toBe(false);
  await test.info().attach("authored-good-reference", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
  await page.setContent(
    `<!doctype html><html lang="en"><title>Poor reference</title><main style="width:900px"><h1>Inventory</h1><button style="width:50px;height:30px"></button><div role="table"><div role="row"><span role="columnheader">Item</span></div><div role="row"><span role="cell" style="display:inline-block;margin-left:80px">Bottle</span></div></div><div style="width:20px;overflow:hidden"><button style="width:200px">Clipped action</button></div></main></html>`,
  );
  const poor = await measurePage(page);
  for (const kind of [
    "document-overflow",
    "possible-clipping",
    "possible-column-misalignment",
  ])
    expect(poor.findings.some((f) => f.kind === kind)).toBe(true);
  expect(
    poor.accessibility.violations.some((v) => v.id === "button-name"),
  ).toBe(true);
  await test.info().attach("authored-poor-reference", {
    body: await page.screenshot(),
    contentType: "image/png",
  });
});

test("style evidence uses the active theme and reports diversified DOM coverage", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.setContent(`<!doctype html><style>
    :root { --theme-text: rgb(20, 20, 20) }
    .dark { --theme-text: rgb(230, 230, 230) }
    .item { color: var(--theme-text) }
  </style><body class="dark"><main>${Array.from({ length: 130 }, (_, index) => `<button class="item" style="display:block;margin-top:${index === 0 ? 0 : 12}px">Item ${index}</button>`).join("")}</main></body>`);
  const styles = await measureStyles(page, {
    "--color-text": "var(--theme-text)",
    "--theme-text": "var(--theme-text)",
  });
  expect(styles.sampledElements).toBe(120);
  expect(styles.sampling.eligible).toBeGreaterThanOrEqual(130);
  expect(styles.sampling.regions.top.sampled).toBeGreaterThan(0);
  expect(
    styles.observations.some(
      (item) =>
        item.computed === "rgb(230, 230, 230)" &&
        item.classification === "semantic-token-reference",
    ),
  ).toBe(true);
  // No stylesheet URL was supplied by this fixture; browser evidence must not
  // manufacture generated provenance from a visual token match.
  expect(
    styles.observations.some((item) => item.provenance === "generated"),
  ).toBe(false);
});
