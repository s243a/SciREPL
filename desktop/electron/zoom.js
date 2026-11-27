/**
 * zoom.js — page zoom from the keyboard and the mouse wheel.
 *
 * Electron's built-in Zoom In role is bound to Ctrl+Plus, which on a US
 * keyboard needs Shift, so the Ctrl+= that browsers accept did nothing while
 * Ctrl+- worked (pilot run 4). And Ctrl+wheel zoom is a browser feature that
 * Electron does not enable: it only reports the gesture as `zoom-changed`.
 * Both are handled here, in the main process, with the same step and limits
 * as the menu roles, so every route changes the same zoom level.
 */

/** Zoom-level step of Electron's zoomIn/zoomOut roles. */
const ZOOM_STEP = 0.5;
/** Roughly 33% to 300%, in Chromium zoom levels (factor = 1.2^level). */
const MIN_ZOOM_LEVEL = -6;
const MAX_ZOOM_LEVEL = 6;

/** The zoom level after one step in `direction` ('in' | 'out'). */
function nextZoomLevel(level, direction) {
  const current = Number.isFinite(level) ? level : 0;
  const delta = direction === 'in' ? ZOOM_STEP : direction === 'out' ? -ZOOM_STEP : 0;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, current + delta));
}

/** Ctrl+wheel and touchpad pinch: Electron emits `zoom-changed` for both. */
function installWheelZoom(contents) {
  contents.on('zoom-changed', (_event, direction) => {
    contents.setZoomLevel(nextZoomLevel(contents.getZoomLevel(), direction));
  });
}

module.exports = { ZOOM_STEP, MIN_ZOOM_LEVEL, MAX_ZOOM_LEVEL, nextZoomLevel, installWheelZoom };
