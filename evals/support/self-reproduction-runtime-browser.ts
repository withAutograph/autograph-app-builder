import { desktopViewports } from "./self-reproduction-parity";

/** Diagnostic captures only; these do not stand in for seeded parity states. */
export function sandboxBrowserComparison() {
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
const browser = await chromium.launch({ headless: true });
try {
  for (const viewport of ${JSON.stringify(desktopViewports)}) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    const outcome = { viewport: viewport.name, kind: 'diagnostic', root: null, documentation: null, errors: [] };
    try {
      const response = await page.goto(input.baseURL, { waitUntil: 'domcontentloaded' });
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
  return { script, artifactPaths };
}
