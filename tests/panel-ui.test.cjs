'use strict';

/**
 * Guards the panel's narrow-sidebar UI.
 *
 * The panel lives in a resizable PI-Desktop sidebar, so the layout is a single
 * control row plus a full-width terminal: the session button on the left, then
 * `+`, `▾` (pick a shell) and `…` (clear / restart / details / close). The
 * permanent tab strip and the bottom status bar are gone on purpose — details
 * moved into the `…` menu. These tests keep that shape and, more importantly,
 * keep `index.html` and the lookups in `app.js` in sync.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');

function idsInHtml() {
  const ids = new Set();
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) ids.add(match[1]);
  return ids;
}

function idsLookedUp() {
  const ids = new Set();
  for (const match of app.matchAll(/getElementById\('([^']+)'\)/g)) ids.add(match[1]);
  return ids;
}

test('every element the panel looks up exists in index.html', () => {
  const present = idsInHtml();
  const missing = [...idsLookedUp()].filter((id) => !present.has(id));
  assert.deepEqual(missing, [], `index.html is missing: ${missing.join(', ')}`);
});

test('the control bar is one row: session plus three icon buttons', () => {
  assert.match(html, /class="bar"/, 'the control bar is missing');
  for (const id of ['session', 'session-dot', 'session-name', 'new', 'new-shell', 'more']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is missing from the control bar`);
  }
  for (const id of ['new', 'new-shell', 'more']) {
    const tag = html.slice(html.indexOf(`id="${id}"`) - 200, html.indexOf(`id="${id}"`) + 260);
    assert.match(tag, /aria-label="[^"]+"/, `${id} needs an accessible name`);
    assert.match(tag, /title="[^"]+"/, `${id} needs a tooltip`);
  }
});

test('the permanent tab strip and bottom status bar are gone', () => {
  assert.ok(!/id="tabs"/.test(html), 'the horizontal tab strip must be gone');
  assert.ok(!/id="shell-picker"/.test(html), 'the always-visible shell select must be gone');
  assert.ok(!/id="status-/.test(html), 'the bottom status bar must be gone');
  assert.ok(!/class="status"/.test(html), 'the bottom status bar must be gone');
  assert.ok(!/<select\b/.test(html), 'no permanent shell select');
});

test('session list, shell list, more menu and details are popovers', () => {
  for (const id of ['pop-sessions', 'pop-shells', 'pop-more', 'pop-details', 'menu']) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is missing`);
  }
  assert.match(html, /id="pop-sessions-list"/, 'the session list needs its own scroll container');
  assert.match(
    html,
    /\.pop-scroll\s*\{[^}]*max-height[^}]*overflow-y:\s*auto/s,
    'long session lists must scroll inside the panel',
  );
});

test('close sits at the bottom of the more menu, separated from the rest', () => {
  const menu = html.slice(html.indexOf('id="pop-more"'));
  const closeAt = menu.indexOf('data-action="close"');
  assert.ok(closeAt > 0, 'the more menu needs a close item');
  const separator = menu.lastIndexOf('pop-sep', closeAt);
  assert.ok(separator > 0 && separator < closeAt, 'close must be separated by a divider');
  for (const action of ['clear', 'restart', 'details']) {
    assert.ok(menu.indexOf(`data-action="${action}"`) < closeAt, `${action} must come before close`);
  }
});

test('details replace the status bar, and the startup directory is labelled as such', () => {
  assert.match(app, /function renderDetails\(/, 'the details view is missing');
  assert.match(app, /detailCwd|startupDir/, 'details must show where the shell was started');
  assert.ok(
    !/状态栏|status bar/.test(html),
    'no leftover status bar markup',
  );
});

test('popovers are clamped to the visible panel', () => {
  assert.match(html, /\.popover\s*\{[^}]*max-width:\s*min\(/s, 'popovers must not exceed the panel');
  assert.match(app, /function placePopover\(/, 'popovers need a placement helper that clamps');
});

test('the panel can put focus back into the terminal', () => {
  assert.match(app, /function focusTerminal\(/, 'focus must return to the terminal after switching');
});

test('no new runtime dependencies were added to the renderer', () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(scripts, ['vendor/xterm.js', 'vendor/addon-fit.js', 'app.js']);
});
