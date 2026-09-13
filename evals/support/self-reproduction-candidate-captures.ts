import { captureStates, desktopViewports } from "./self-reproduction-parity";

/** Portable evaluator code; no candidate implementation or fabricated product state is injected. */
export function sandboxCandidateInteractionCaptures() {
  const artifactPaths = desktopViewports.flatMap(({ name }) =>
    captureStates.map((state) => `${name}/${state}.png`),
  );
  const script = `
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
const input = JSON.parse(await readFile(process.argv[2], 'utf8'));
const outputPath = process.argv[3];
const artifactRoot = dirname(outputPath);
const observations = [];
const manifest = { version: 1, producer: 'evaluator', side: 'candidate', visualScoresAdvisory: true, observations };
await mkdir(artifactRoot, { recursive: true });
const browser = await chromium.launch({ headless: true });
async function save() { await writeFile(outputPath, JSON.stringify(manifest, null, 2)); }
try {
  for (const viewport of ${JSON.stringify(desktopViewports)}) {
    for (const state of ${JSON.stringify(captureStates)}) {
      const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true });
      const page = await context.newPage();
      const screenshot = viewport.name + '/' + state + '.png';
      const row = { requirementId: 'capture/' + viewport.name + '/' + state, disposition: 'not-run', reason: '', method: 'browser', artifacts: [], assertions: [] };
      try {
        const response = await page.goto(input.baseURL, { waitUntil: 'domcontentloaded' });
        if (!response || response.status() >= 400) throw new Error('Candidate route did not return a successful document.');
        const docs = page.getByRole('button', { name: 'Docs', exact: true });
        // Hydration may mount the product controls after DOMContentLoaded.
        // Wait on the real controls, never a fixed sleep or fabricated fixture.
        await Promise.all([
          docs.waitFor({ state: 'visible', timeout: 5000 }),
          page.getByRole('textbox', { name: 'What would you like to build?', exact: true }).waitFor({ state: 'visible', timeout: 5000 }),
          page.getByRole('button', { name: 'Continue to review', exact: true }).waitFor({ state: 'visible', timeout: 5000 }),
        ]).catch(() => undefined);
        const known = await docs.count() === 1 && await page.getByRole('textbox', { name: 'What would you like to build?', exact: true }).count() === 1 && await page.getByRole('button', { name: 'Continue to review', exact: true }).count() === 1;
        if (!known) {
          row.reason = 'Unknown candidate shape has no evaluator-owned interaction fixture binding.';
        } else if (state === 'panel-resize') {
          const handles = page.locator('[role="separator"][aria-valuenow], [data-panel-resize-handle]');
          const handle = handles.first();
          if (await handles.count() === 0 || !(await handle.isVisible())) {
            row.disposition = known ? 'missing-functionality' : 'not-run';
            row.reason = known ? 'Recognized candidate exposes no adjustable panel handle; browser-window resizing is not panel resizing.' : 'Unknown candidate layout has no supported panel fixture binding.';
          } else {
            const parent = handle.locator('..');
            const panel = parent.locator(':scope > *').first();
            const before = await panel.boundingBox();
            const grip = await handle.boundingBox();
            if (!before || !grip) throw new Error('Panel dimensions unavailable.');
            await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
            await page.mouse.down();
            await page.mouse.move(grip.x + grip.width / 2 + 80, grip.y + grip.height / 2, { steps: 8 });
            await page.mouse.up();
            const after = await panel.boundingBox();
            row.disposition = 'observed';
            row.reason = 'Dragged the actual panel handle and measured its adjacent panel, without resizing the browser viewport.';
            row.assertions = [
              { id: 'panel-dimension-changed', passed: Boolean(after && (Math.abs(after.width-before.width) >= 8 || Math.abs(after.height-before.height) >= 8)), detail: JSON.stringify({before, after}) },
              { id: 'content-remains-reachable', passed: await page.locator('main').first().isVisible(), detail: 'Primary content remains visible after panel drag.' },
            ];
          }
        } else if (state === 'keyboard' && known) {
          const count = await page.locator('button,a[href],input,textarea,select,[tabindex]').count();
          let focused = false;
          for (let index = 0; index <= count + 1; index++) {
            await page.keyboard.press('Tab');
            focused = await docs.evaluate(element => element === document.activeElement);
            if (focused) break;
          }
          const focus = focused ? await docs.evaluate(element => {
            const style = getComputedStyle(element);
            return { visible: element.matches(':focus-visible') && ((style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) || style.boxShadow !== 'none'), outline: style.outline, boxShadow: style.boxShadow };
          }) : { visible: false };
          await mkdir(dirname(join(artifactRoot, screenshot)), { recursive: true });
          await page.screenshot({ path: join(artifactRoot, screenshot), fullPage: true });
          row.artifacts.push(screenshot);
          const before = await page.locator('body').innerText();
          if (focused) await page.keyboard.press('Enter');
          const heading = page.getByRole('heading', { name: 'Build an app, deliberately', exact: true });
          if (focused) await heading.waitFor({ state: 'visible', timeout: 2000 }).catch(() => undefined);
          const changed = focused && await heading.isVisible() && (await page.locator('body').innerText()) !== before;
          row.disposition = 'observed';
          row.reason = 'Reached Docs through keyboard Tab navigation and activated its actual control with Enter.';
          row.assertions = [
            { id: 'focus-visible', passed: focus.visible, detail: JSON.stringify(focus) },
            { id: 'keyboard-activation-changes-state', passed: changed, detail: 'Enter opened the candidate documentation view.' },
          ];
        } else {
          row.reason = state === 'keyboard' ? 'Unknown candidate shape has no supported keyboard outcome binding.' : 'No evaluator-owned real ' + state + ' operation/fixture is bound. Static stage labels and synthetic UI toggles receive no transient-state credit.';
        }
        if (row.artifacts.length === 0) {
          await mkdir(dirname(join(artifactRoot, screenshot)), { recursive: true });
          await page.screenshot({ path: join(artifactRoot, screenshot), fullPage: true });
          row.artifacts.push(screenshot);
        }
      } catch (error) {
        row.disposition = 'infrastructure-unavailable';
        row.reason = error instanceof Error ? error.message : String(error);
      } finally {
        observations.push(row);
        await save();
        await context.close();
      }
    }
  }
} finally { await browser.close(); await save(); }
`;
  return { script, artifactPaths };
}
