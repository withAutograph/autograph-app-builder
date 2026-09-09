import { expect, test } from "playwright/test";
import { measurePage, measureStyles } from "./browser";
import { collectIntrinsicClassSignatures } from "./class-evidence";
import { collectCssRuleEvidence } from "./css-evidence";

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
    good.intentionalScrollContainers.some((item) => item.axis === "x"),
  ).toBe(true);
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

test("reports intentional vertical scrolling as a diagnostic", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.setContent(
    `<!doctype html><main style="height:80px;overflow-y:auto"><div style="height:240px">Scrollable details</div></main>`,
  );
  const measured = await measurePage(page);
  const vertical = measured.intentionalScrollContainers.find(
    (item) => item.axis === "y",
  );
  expect(vertical).toMatchObject({
    axis: "y",
    scrollHeight: 240,
    clientHeight: 80,
  });
});

test("settles a finite border transition before style evidence", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><style>
    .panel { border-top: 4px solid rgb(41, 41, 41); transition: border-color 120ms linear; }
    .panel.selected { border-color: rgb(77, 95, 193); }
  </style><div class="panel">Stock</div>`);
  await page
    .locator(".panel")
    .evaluate((element) => element.classList.add("selected"));
  const styles = await measureStyles(page, {
    "--color-border-subtle": "rgb(41, 41, 41)",
    "--color-action-primary-ink": "rgb(77, 95, 193)",
  });
  expect(
    await page
      .locator(".panel")
      .evaluate((element) => getComputedStyle(element).borderTopColor),
  ).toBe("rgb(77, 95, 193)");
  expect(
    styles.observations.some(
      (item) =>
        item.property === "border-top-color" &&
        item.computed === "rgb(77, 95, 193)",
    ),
  ).toBe(true);
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

test("browser signature attribution is reviewer evidence, not score provenance", async ({
  page,
}) => {
  await page.goto("about:blank");
  await page.setContent(`<!doctype html><style>
    :root { --color-text-primary: rgb(20, 20, 20) }
    .generated-card { color: var(--color-text-primary) }
  </style><section class="generated-card tokenized">Stock</section>`);
  const generated = collectIntrinsicClassSignatures([
    {
      path: "src/Stock.tsx",
      content:
        'export function Stock(){ return <section className="generated-card tokenized">Stock</section> }',
    },
  ]);
  const candidate = await measureStyles(
    page,
    { "--color-text-primary": "rgb(20, 20, 20)" },
    [],
    generated,
    [],
  );
  expect(
    candidate.observations.some(
      (item) =>
        item.property === "color" &&
        item.provenance === "unknown" &&
        item.verdict === "unassessed" &&
        item.originCandidate?.provenance === "generated",
    ),
  ).toBe(true);
  const sharedDynamic = collectIntrinsicClassSignatures([
    {
      path: "packages/design-systems/Card.tsx",
      content:
        'const classes = "generated-card tokenized"; export function Card(){ return <section className={classes}>Shared</section> }',
    },
  ]);
  // Dynamic shared classes do not appear in the static inventory, which is why
  // a matching generated signature remains only a reviewer candidate.
  expect(sharedDynamic).toEqual([]);
  const collision = await measureStyles(
    page,
    { "--color-text-primary": "rgb(20, 20, 20)" },
    [],
    generated,
    sharedDynamic,
  );
  expect(
    collision.observations.some(
      (item) =>
        item.property === "color" &&
        item.provenance === "unknown" &&
        item.verdict === "unassessed",
    ),
  ).toBe(true);
});

test("attributes an anonymous live stylesheet only through an exact supplied CSS rule", async ({
  page,
}) => {
  const css = ".screen { color: var(--color-text-primary); }";
  await page.goto("about:blank");
  await page.setContent(
    `<style>:root { --color-text-primary: rgb(20, 20, 20) }${css}</style><main class="screen">Stock</main>`,
  );
  const rules = collectCssRuleEvidence([
    { path: "src/screen.css", content: css },
  ]);
  const styles = await measureStyles(
    page,
    { "--color-text-primary": "rgb(20, 20, 20)" },
    [],
    [],
    [],
    rules,
    [],
  );
  expect(
    styles.observations.some(
      (item) =>
        item.property === "color" &&
        item.provenance === "generated" &&
        item.verdict === "conforming" &&
        item.source?.path === "src/screen.css",
    ),
  ).toBe(true);
});

test("attributes a matched stylesheet declaration through its CSS source map", async ({
  page,
}) => {
  // Keep selector lengths equal so the generated declaration's range maps to
  // the authored property range, while preventing exact-rule attribution.
  const authoredCss = ".origin { color: var(--color-text-primary); }";
  const compiledCss = ".screen { color: var(--color-text-primary); }";
  const map = JSON.stringify({
    version: 3,
    sources: ["src/generated.css"],
    sourcesContent: [authoredCss],
    // CDP begins the declaration range at its preceding space (column 9),
    // while the authored declaration itself begins at column 10.
    mappings: "SAAU",
  });
  await page.route("http://example.test/page", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.route("http://example.test/generated.css.map", (route) =>
    route.fulfill({ contentType: "application/json", body: map }),
  );
  await page.route("http://example.test/compiled.css", (route) =>
    route.fulfill({
      contentType: "text/css",
      body: `${compiledCss}\n/*# sourceMappingURL=/generated.css.map */`,
    }),
  );
  await page.goto("http://example.test/page");
  const sourceFiles = [{ path: "src/generated.css", content: authoredCss }];
  const sourceRules = collectCssRuleEvidence(sourceFiles);
  await page.setContent(
    `<style>${compiledCss}</style><main class="screen">Stock</main>`,
  );
  const withoutMap = await measureStyles(
    page,
    { "--color-text-primary": "rgb(20, 20, 20)" },
    ["src/generated.css"],
    [],
    undefined,
    sourceRules,
    [],
    sourceFiles,
  );
  expect(
    withoutMap.observations.some(
      (item) => item.property === "color" && item.provenance === "generated",
    ),
  ).toBe(false);
  await page.setContent(
    `<link rel="stylesheet" href="/compiled.css"><main class="screen">Stock</main>`,
  );
  await page.locator(".screen").waitFor();
  await page.evaluate(() => document.styleSheets[0]?.cssRules.length);
  const styles = await measureStyles(
    page,
    { "--color-text-primary": "rgb(20, 20, 20)" },
    ["src/generated.css"],
    [],
    undefined,
    sourceRules,
    [],
    sourceFiles,
  );
  expect(
    styles.observations.some(
      (item) =>
        item.property === "color" &&
        item.provenance === "generated" &&
        item.cssSource?.path === "src/generated.css",
    ),
  ).toBe(true);
});

test("reports an exactly mapped shared declaration as shared without scoring credit", async ({
  page,
}) => {
  const sharedPath = "packages/design-systems/core/card.css";
  const authoredCss = ".origin { color: var(--color-text-primary); }";
  const compiledCss = ".screen { color: var(--color-text-primary); }";
  const map = JSON.stringify({
    version: 3,
    sources: [sharedPath],
    sourcesContent: [authoredCss],
    mappings: "SAAU",
  });
  await page.route("http://example.test/page", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.route("http://example.test/shared.css.map", (route) =>
    route.fulfill({ contentType: "application/json", body: map }),
  );
  await page.route("http://example.test/compiled.css", (route) =>
    route.fulfill({
      contentType: "text/css",
      body: `${compiledCss}\n/*# sourceMappingURL=/shared.css.map */`,
    }),
  );
  await page.goto("http://example.test/page");
  const sharedFiles = [{ path: sharedPath, content: authoredCss }];
  const withoutMap = await measureStyles(
    page,
    { "--color-text-primary": "rgb(20, 20, 20)" },
    [],
    [],
    undefined,
    [],
    collectCssRuleEvidence(sharedFiles),
    [],
    sharedFiles,
  );
  expect(
    withoutMap.observations.some(
      (item) => item.property === "color" && item.provenance === "shared",
    ),
  ).toBe(false);
  await page.setContent(
    `<link rel="stylesheet" href="/compiled.css"><main class="screen">Stock</main>`,
  );
  await page.locator(".screen").waitFor();
  await page.evaluate(() => document.styleSheets[0]?.cssRules.length);
  const styles = await measureStyles(
    page,
    { "--color-text-primary": "rgb(20, 20, 20)" },
    [],
    [],
    undefined,
    [],
    collectCssRuleEvidence(sharedFiles),
    [],
    sharedFiles,
  );
  expect(
    styles.observations.some(
      (item) =>
        item.property === "color" &&
        item.provenance === "shared" &&
        item.verdict === "unassessed" &&
        item.cssSource?.path === sharedPath,
    ),
  ).toBe(true);
});

test("keeps multiple mapped cascade declarations unknown", async ({ page }) => {
  const sharedPath = "packages/design-systems/core/card.css";
  const authoredCss = ".origin { color: var(--color-text-primary); }";
  const compiledCss =
    ".screen { color: var(--color-text-primary); }\n.screen { color: var(--color-text-primary); }";
  const map = JSON.stringify({
    version: 3,
    sources: [sharedPath],
    sourcesContent: [authoredCss],
    mappings: "SAAU;SAAA",
  });
  await page.route("http://example.test/page", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.route("http://example.test/ambiguous.css.map", (route) =>
    route.fulfill({ contentType: "application/json", body: map }),
  );
  await page.route("http://example.test/ambiguous.css", (route) =>
    route.fulfill({
      contentType: "text/css",
      body: `${compiledCss}\n/*# sourceMappingURL=/ambiguous.css.map */`,
    }),
  );
  await page.goto("http://example.test/page");
  const sharedFiles = [{ path: sharedPath, content: authoredCss }];
  await measureStyles(
    page,
    { "--color-text-primary": "rgb(20, 20, 20)" },
    [],
    [],
    undefined,
    [],
    collectCssRuleEvidence(sharedFiles),
    [],
    sharedFiles,
  );
  await page.setContent(
    `<link rel="stylesheet" href="/ambiguous.css"><main class="screen">Stock</main>`,
  );
  await page.locator(".screen").waitFor();
  await page.evaluate(() => document.styleSheets[0]?.cssRules.length);
  const styles = await measureStyles(
    page,
    { "--color-text-primary": "rgb(20, 20, 20)" },
    [],
    [],
    undefined,
    [],
    collectCssRuleEvidence(sharedFiles),
    [],
    sharedFiles,
  );
  expect(
    styles.observations.some(
      (item) => item.property === "color" && item.provenance === "shared",
    ),
  ).toBe(false);
});

test("does not trust mismatched CSS source-map content", async ({ page }) => {
  const authoredCss = ".origin { color: var(--color-text-primary); }";
  const compiledCss = ".screen { color: var(--color-text-primary); }";
  const map = JSON.stringify({
    version: 3,
    sources: ["src/generated.css"],
    sourcesContent: [".origin { color: red; }"],
    mappings: "SAAU",
  });
  await page.route("http://example.test/page", (route) =>
    route.fulfill({ body: "" }),
  );
  await page.route("http://example.test/generated.css.map", (route) =>
    route.fulfill({ contentType: "application/json", body: map }),
  );
  await page.route("http://example.test/compiled.css", (route) =>
    route.fulfill({
      contentType: "text/css",
      body: `${compiledCss}\n/*# sourceMappingURL=/generated.css.map */`,
    }),
  );
  await page.goto("http://example.test/page");
  await page.setContent(
    `<link rel="stylesheet" href="/compiled.css"><main class="screen">Stock</main>`,
  );
  await page.locator(".screen").waitFor();
  const styles = await measureStyles(
    page,
    { "--color-text-primary": "rgb(20, 20, 20)" },
    ["src/generated.css"],
    [],
    undefined,
    collectCssRuleEvidence([
      { path: "src/generated.css", content: authoredCss },
    ]),
    [],
    [{ path: "src/generated.css", content: authoredCss }],
  );
  expect(
    styles.observations.some(
      (item) =>
        item.property === "color" &&
        item.provenance === "unknown" &&
        item.verdict === "unassessed",
    ),
  ).toBe(true);
});
