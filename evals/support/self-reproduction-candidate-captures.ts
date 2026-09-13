import { captureStates, desktopViewports } from "./self-reproduction-parity";

/** Portable evaluator code; no candidate implementation or fabricated product state is injected.
 * Loading credit requires an evaluator-owned payload.creationMutation { pathname, method }
 * binding; the default records diagnostics without inferring an operation from arbitrary requests.
 */
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
        } else if (state === 'empty') {
          const brief = page.getByRole('textbox', { name: 'What would you like to build?', exact: true });
          const continueButton = page.getByRole('button', { name: 'Continue to review', exact: true });
          const originalBrief = await brief.inputValue();
          await brief.fill('');
          const empty = await brief.inputValue() === '';
          const blocked = await continueButton.isDisabled();
          const guidance = (await brief.getAttribute('placeholder') ?? '').trim();
          await mkdir(dirname(join(artifactRoot, screenshot)), { recursive: true });
          await page.screenshot({ path: join(artifactRoot, screenshot), fullPage: true });
          row.artifacts.push(screenshot);
          await brief.fill(originalBrief || 'Create a private task tracker for the synthetic evaluation workspace.');
          const enabled = await continueButton.isEnabled();
          if (enabled) await continueButton.click();
          const approve = page.getByRole('button', { name: 'Approve and create', exact: true });
          if (enabled) await approve.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
          row.disposition = 'observed';
          row.reason = 'Cleared the real brief, captured its empty guidance and blocked continuation, then refilled it and opened review.';
          row.assertions = [
            { id: 'empty-state-visible', passed: empty && blocked && guidance.length > 0, detail: JSON.stringify({ empty, continuationDisabled: blocked, placeholder: guidance }) },
            { id: 'next-action-works', passed: enabled && await approve.isVisible(), detail: 'Refilling the real field enabled continuation and opened approval review.' },
          ];
        } else if (state === 'loading') {
          const held = [];
          const requests = [];
          const origin = new URL(input.baseURL).origin;
          const intercept = async route => {
            const request = route.request();
            if (input.creationMutation && new URL(request.url()).origin === origin && new URL(request.url()).pathname === input.creationMutation.pathname && request.method() === input.creationMutation.method && ['fetch', 'xhr'].includes(request.resourceType()) && !['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
              requests.push({ method: request.method(), path: new URL(request.url()).pathname });
              held.push(route);
            } else await route.continue();
          };
          try {
            await page.getByRole('button', { name: 'Continue to review', exact: true }).click();
            const approve = page.getByRole('button', { name: 'Approve and create', exact: true });
            await approve.waitFor({ state: 'visible', timeout: 5000 });
            await page.route('**/*', intercept);
            await approve.click();
            const pending = page.getByText('Creating private preview', { exact: true }).first();
            await pending.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
            const visible = await pending.isVisible();
            const manualCompletion = await page.getByRole('button', { name: 'Finish preview', exact: true }).isVisible();
            await mkdir(dirname(join(artifactRoot, screenshot)), { recursive: true });
            await page.screenshot({ path: join(artifactRoot, screenshot), fullPage: true });
            row.artifacts.push(screenshot);
            if (held.length > 0) {
              row.disposition = 'observed';
              row.reason = 'Held an actual same-origin creation mutation and captured its pending UI before releasing the request.';
              row.assertions = [
                { id: 'pending-held', passed: true, detail: JSON.stringify({ heldRequests: requests }) },
                { id: 'useful-loading-visible', passed: visible, detail: 'Creation-specific pending text remained visible while the actual mutation was held.' },
              ];
            } else {
              row.reason = 'Creation controls were exercised, but no evaluator-bound creation mutation was held. Static creating text or a manual completion button cannot establish pending behavior. Observed: ' + JSON.stringify({ pendingLabelVisible: visible, manualCompletionVisible: manualCompletion, requests });
            }
          } finally {
            await Promise.all(held.map(route => route.abort('aborted').catch(() => undefined)));
            await page.unroute('**/*', intercept);
          }
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
