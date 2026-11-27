/**
 * zoom.test.mjs — Ctrl+mouse wheel zooms the page (zoom.js).
 *
 * The input is injected through the browser process with
 * `webContents.sendInputEvent`, the path real wheel input takes. Playwright's
 * `page.mouse.wheel` goes through CDP and never reaches Electron's
 * `zoom-changed`, so a test built on it passes or fails for the wrong reason.
 * Measured while writing this: with `sendInputEvent` each wheel tick is
 * reported twice, so the assertions are on direction, not exact counts.
 */

import { launchShell, createReporter, waitForAppReady } from './harness.mjs';

export default async function run() {
  const r = createReporter('zoom');
  const shell = await launchShell();
  try {
    const { page, electronApp } = shell;
    await waitForAppReady(page);
    const level = () => electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.getZoomLevel());
    const wheel = (deltaY, modifiers) => electronApp.evaluate(({ BrowserWindow }, { deltaY, modifiers }) => {
      BrowserWindow.getAllWindows()[0].webContents.sendInputEvent({
        type: 'mouseWheel', x: 400, y: 300, deltaX: 0, deltaY, wheelTicksY: deltaY / 120,
        modifiers, canScroll: true,
      });
    }, { deltaY, modifiers });
    const settle = () => page.waitForTimeout(500);

    const start = await level();
    r.log('starts at the default zoom', start === 0, String(start));

    await wheel(120, ['control']); await settle();
    const zoomedIn = await level();
    r.log('Ctrl+wheel up zooms in', zoomedIn > start, String(zoomedIn));

    await wheel(-120, ['control']); await settle();
    await wheel(-120, ['control']); await settle();
    const zoomedOut = await level();
    r.log('Ctrl+wheel down zooms out', zoomedOut < zoomedIn, String(zoomedOut));

    const before = await level();
    await wheel(120, []); await settle();
    r.log('a wheel without Ctrl does not zoom', (await level()) === before);

    for (let i = 0; i < 30; i++) await wheel(120, ['control']);
    await settle();
    const top = await level();
    r.log('zoom in stops at the limit', top === 6, String(top));
  } finally {
    await shell.close();
  }
  return r.summary();
}
