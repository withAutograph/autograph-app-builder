import { selfReproductionDraft } from "./self-reproduction-draft-fixture";
import { desktopViewports } from "./self-reproduction-parity";

/** Diagnostic captures only; these do not stand in for seeded parity states. */
export const sandboxBrowserComparison = () => {
  const artifactPaths = desktopViewports.flatMap(({ name }) => [
    `${name}/root.png`,
    `${name}/documentation.png`,
  ]);
  const script = `
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const outputPath = process.argv[3];
const artifactRoot = dirname(outputPath);
const outcomes = [];
const draft = ${JSON.stringify(selfReproductionDraft)};
const prepareVisibleDraft = async (page) => {
  const fixture = {
    state: 'visible-draft', status: 'unassessed', draft,
    authentication: 'unassessed', durability: 'unassessed',
    qualification: 'Matching visible input values does not prove authentication, durable persistence, or workflow correctness.',
  };
  try {
    const appName = page.getByRole('textbox', { name: 'App name', exact: true });
    const brief = page.getByRole('textbox', { name: 'What would you like to build?', exact: true });
    await Promise.all([
      appName.waitFor({ state: 'visible', timeout: 10000 }),
      brief.waitFor({ state: 'visible', timeout: 10000 }),
      page.getByRole('button', { name: 'Docs', exact: true }).waitFor({ state: 'visible', timeout: 10000 }),
      page.getByRole('button', { name: 'Continue to review', exact: true }).waitFor({ state: 'visible', timeout: 10000 }),
    ]);
    await appName.fill(draft.appName);
    await brief.fill(draft.brief);
    const matched = await appName.inputValue() === draft.appName && await brief.inputValue() === draft.brief;
    return { ...fixture, status: matched ? 'prepared' : 'unassessed', matched,
      reason: matched ? 'Known candidate controls contain the same synthetic app name and brief as the reference capture.' : 'Visible controls did not retain the requested synthetic values.' };
  } catch {
    return { ...fixture, matched: false, reason: 'Known candidate draft controls were unavailable or could not be prepared; this screenshot is diagnostic and state parity is unassessed.' };
  }
};
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of ${JSON.stringify(desktopViewports)}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const outcome = { viewport: viewport.name, kind: 'diagnostic', root: null, documentation: null, errors: [] };
    try {
      const response = await page.goto(input.baseURL, { waitUntil: 'domcontentloaded' });
      outcome.fixture = await prepareVisibleDraft(page);
      const rootURL = page.url();
      const rootText = (await page.locator('body').innerText()).trim();
      await mkdir(join(artifactRoot, viewport.name), { recursive: true });
      await page.screenshot({ path: join(artifactRoot, viewport.name, 'root.png'), fullPage: true });
      outcome.root = { url: rootURL, status: response?.status() ?? null, readable: rootText.length > 0 };
      const docsResponse = await page.goto(input.baseURL.replace(/\\/$/, '') + '/docs', { waitUntil: 'domcontentloaded' });
      const docsText = (await page.locator('body').innerText()).trim();
      await page.screenshot({ path: join(artifactRoot, viewport.name, 'documentation.png'), fullPage: true });
      await page.goBack({ waitUntil: 'domcontentloaded' });
      outcome.documentation = { status: docsResponse?.status() ?? null, readable: docsText.length > 40, returned: page.url() === rootURL };
    } catch (error) {
      outcome.errors.push(error instanceof Error ? error.message : String(error));
    } finally {
      await context.close();
      outcomes.push(outcome);
      await writeFile(outputPath, JSON.stringify({ version: 1, producer: 'evaluator', outcomes }));
    }
  }
} finally {
  await browser.close();
}
`;
  return { artifactPaths, script };
}
