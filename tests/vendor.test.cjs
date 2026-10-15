'use strict';

/**
 * Guards the vendored browser assets.
 *
 * Why this test exists: `renderer/vendor/xterm.js` was once rewritten through a
 * PowerShell text-mode round-trip, which decoded its UTF-8 bytes as CP936 and
 * wrote them back as UTF-8. The page then failed to parse the script, so
 * `window.Terminal` never existed and the panel could not create a terminal at
 * all ("window.Terminal is not a constructor") while it still looked healthy.
 *
 * The pinned hashes are the main guard: they were taken from copies verified in
 * a real browser, so any byte that changes (mojibake, truncation, the wrong
 * file) fails here. On top of that xterm.js is loaded with a static require,
 * which proves it parses and exports in a real JS engine — deliberately without
 * evaluating code dynamically, because the plugin center's audit blocks `vm`,
 * `new Function`, `eval` and computed require paths inside a package.
 * addon-fit.js cannot be loaded that way (its UMD wrapper passes `self`, which
 * Node does not define), so its hash plus the structural checks cover it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = path.resolve(__dirname, '..');
const vendorDir = path.join(root, 'renderer', 'vendor');

/** Pinned hashes of the files we ship (see THIRD-PARTY-NOTICES.md). */
const EXPECTED = {
  'xterm.js': '7A88E46A58847D3F17109E3D48CC8AA056A01997D00CEB76035F63370712D858',
  'xterm.css': 'BA8E6985669488981CCF40C0CEFE3ABA80722CB6C92DE7AD628B0BD717FAF2B6',
  'xterm.LICENSE': 'B569F629D00F2626A8100DF2A1798210535621E42164DFD426A6FE5AAC7B0CCD',
  'addon-fit.js': '3E9AE6F6965EE1269D5574B905CF1BF559C2F44C784255B0034A71387E7719C9',
  'addon-fit.LICENSE': 'E256F01188AF527E4D06D21D06FBF785AE9C50D4B328BF03CBE0BA7F0AA4228F',
  'addon-fit.package.json': '5A70FC5520AB1B7B4C4D9E527ACC78395E99A8AA539DE583C930F5671DBCC044',
};

const SCRIPTS = ['xterm.js', 'addon-fit.js'];

function read(name) {
  return fs.readFileSync(path.join(vendorDir, name));
}

test('every vendored file still has the hash we pinned', () => {
  for (const [name, expected] of Object.entries(EXPECTED)) {
    const actual = crypto.createHash('sha256').update(read(name)).digest('hex').toUpperCase();
    assert.equal(actual, expected, `${name} changed; re-vendor it from npm and update the pin`);
  }
});

test('xterm.js parses in a real JS engine and exports Terminal', () => {
  // A static require of a file we ship; not dynamic code execution. The plugin
  // center's audit rejects `vm`, `new Function`, `eval` and computed paths.
  const xterm = require('../renderer/vendor/xterm.js');
  assert.equal(typeof xterm.Terminal, 'function', 'xterm.js must load and export Terminal');
});

for (const name of SCRIPTS) {
  test(`${name} carries no encoding damage`, () => {
    const source = read(name).toString('utf8');
    assert.ok(!source.includes('\uFFFD'), `${name} contains U+FFFD replacement characters`);
    // CP936 mojibake replaces unmappable bytes with '?' and mangles the two
    // characters xterm.js legitimately contains (NBSP U+00A0, and the DEC
    // special-graphics glyphs): "\u00a0" turned into a full-width CJK letter.
    assert.ok(
      !/[\u3000-\u9fff]/.test(source),
      `${name} contains CJK characters, which means it was decoded with the wrong code page`,
    );
  });
}

test('xterm.js publishes Terminal on the global object for browsers', () => {
  const source = read('xterm.js').toString('utf8');
  // UMD wrapper: without a CommonJS/AMD environment it copies the export onto
  // the global object, which is how the panel reaches `window.Terminal`.
  assert.match(source.slice(0, 200), /^!function\(e,t\)\{/, 'unexpected UMD preamble');
  assert.ok(source.includes('e.Terminal=d'), 'the Terminal export assignment is gone');
  assert.ok(!source.includes('sourceMappingURL'), 'the map comment is back; .map is not shipped');
});

test('addon-fit.js exports FitAddon and no source map reference', () => {
  const source = read('addon-fit.js').toString('utf8');
  assert.ok(source.includes('FitAddon'), 'the FitAddon export is gone');
  assert.ok(!source.includes('sourceMappingURL'), 'the map comment is back; .map is not shipped');
});

test('the renderer loads the vendored scripts before its own code', () => {
  const html = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
  const xtermAt = html.indexOf('vendor/xterm.js');
  const fitAt = html.indexOf('vendor/addon-fit.js');
  const appAt = html.indexOf('app.js');
  assert.ok(xtermAt > 0 && fitAt > 0 && appAt > 0, 'expected all three script tags');
  assert.ok(xtermAt < appAt && fitAt < appAt, 'vendor scripts must load before app.js');
  assert.ok(html.indexOf('vendor/xterm.css') > 0, 'xterm.css must be linked');
});

test('the panel creates terminals through window.Terminal', () => {
  const source = fs.readFileSync(path.join(root, 'renderer', 'app.js'), 'utf8');
  assert.ok(
    source.includes('new window.Terminal('),
    'the panel must use the vendored global, not a module import',
  );
});
