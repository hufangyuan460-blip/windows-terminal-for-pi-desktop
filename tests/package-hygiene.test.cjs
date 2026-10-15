'use strict';

/**
 * Keeps the shipped sources acceptable to the plugin center's audit.
 *
 * That audit refuses a package when it finds dynamic code execution or dynamic
 * module loading — for example evaluating a string as a script, or asking the
 * module system for a file whose name is only known at run time. Both can creep
 * in through test and debug helpers, so this guard scans every script we ship.
 *
 * The forbidden tokens are assembled from pieces, and the labels below avoid
 * them, so the guard's own source never looks like what it forbids.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const FORBIDDEN = [
  { label: 'Node VM evaluation', pattern: ['v', 'm', '\\.', 'Script'].join('') },
  { label: 'the Function constructor', pattern: ['new ', 'Funct', 'ion', '\\('].join('') },
  { label: 'string evaluation', pattern: ['ev', 'al', '\\('].join('') },
  { label: 'a computed module request', pattern: ['requ', 'ire', '\\(', '[^"\']'].join('') },
  { label: 'a computed dynamic import', pattern: ['import', '\\(', '[^"\']'].join('') },
];

const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', 'dist']);

function shippedScripts() {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
        continue;
      }
      if (/\.(cjs|mjs|js)$/.test(entry.name)) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

test('no shipped script evaluates code or loads modules dynamically', () => {
  const files = shippedScripts();
  assert.ok(files.length > 10, `expected to scan the plugin sources, only found ${files.length}`);

  const hits = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const { label, pattern } of FORBIDDEN) {
      const match = new RegExp(pattern).exec(source);
      if (!match) continue;
      const line = source.slice(0, match.index).split('\n').length;
      hits.push(`${path.relative(root, file)}:${line} uses ${label}`);
    }
  }

  assert.deepEqual(hits, [], `the plugin center audit would block this package:\n${hits.join('\n')}`);
});
