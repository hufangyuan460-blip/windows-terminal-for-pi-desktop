'use strict';

/**
 * shells.test.cjs — shell discovery and launch planning.
 *
 * The parsing and path rules are exercised directly; the machine-dependent part
 * (which shell is actually installed) is asserted only as an invariant, so the
 * suite stays honest on a machine without PowerShell 7.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const shells = require('../lib/shells');

test('expands %NAME% against a lookup and leaves unknown names alone', () => {
  const lookup = new Map([['systemroot', 'C:\\Windows'], ['foo', 'bar']]);
  assert.equal(shells.expandEnvVars('%SystemRoot%\\System32', lookup), 'C:\\Windows\\System32');
  assert.equal(shells.expandEnvVars('%NOPE%\\x', lookup), '%NOPE%\\x');
  assert.equal(shells.expandEnvVars('plain', lookup), 'plain');
});

test('splits a PATH list, expanding and unquoting entries with spaces', () => {
  const lookup = new Map([['systemroot', 'C:\\Windows'], ['home', 'C:\\Users\\甲 乙']]);
  const entries = shells.splitPathList('"C:\\Program Files\\PowerShell\\7";%SystemRoot%\\System32;;%HOME%\\bin', lookup);
  assert.deepEqual(entries, [
    'C:\\Program Files\\PowerShell\\7',
    'C:\\Windows\\System32',
    'C:\\Users\\甲 乙\\bin',
  ]);
});

test('parses `reg query` environment output into name/value pairs', () => {
  const text = [
    'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    '    ComSpec    REG_EXPAND_SZ    %SystemRoot%\\system32\\cmd.exe',
    '    Path       REG_EXPAND_SZ    C:\\Windows\\system32;C:\\Program Files\\Git\\cmd',
    '    PATHEXT    REG_SZ    .COM;.EXE;.BAT',
    '',
  ].join('\r\n');
  const parsed = shells.parseRegistryEnvironment(text);
  assert.equal(parsed.ComSpec, '%SystemRoot%\\system32\\cmd.exe');
  assert.equal(parsed.PATHEXT, '.COM;.EXE;.BAT');
  assert.equal(parsed.Path, 'C:\\Windows\\system32;C:\\Program Files\\Git\\cmd');
});

test('finds an executable on a search path, honouring PATHEXT', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-terminal-shells-'));
  try {
    fs.writeFileSync(path.join(directory, 'pwsh.exe'), '');
    const found = shells.findOnPath('pwsh', [path.join(directory, 'missing'), directory], ['.exe']);
    assert.equal(found, path.join(directory, 'pwsh.exe'));
    assert.equal(shells.findOnPath('pwsh', [directory], ['.cmd']), null);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts an existing working directory and falls back with a reason', () => {
  const existing = os.homedir();
  assert.equal(shells.resolveWorkingDirectory(existing).note, null);
  assert.equal(shells.resolveWorkingDirectory(existing).cwd, existing);
  assert.equal(shells.resolveWorkingDirectory('').note, 'no-project');
  const missing = shells.resolveWorkingDirectory('C:\\definitely\\not\\here\\pi-terminal');
  assert.equal(missing.note, 'missing-directory');
  assert.ok(missing.cwd.length > 0, 'a fallback directory is always provided');
});

test('quotes and unquotes paths that arrive wrapped in quotes', () => {
  assert.equal(shells.stripSurroundingQuotes('"C:\\Program Files\\x"'), 'C:\\Program Files\\x');
  assert.equal(shells.stripSurroundingQuotes('  C:\\x  '), 'C:\\x');
  assert.equal(shells.stripSurroundingQuotes('"unterminated'), '"unterminated');
});

test('discovery always lists the three supported shells with their state', () => {
  const discovered = shells.discoverShells();
  assert.deepEqual(discovered.map((shell) => shell.id), ['pwsh', 'windows-powershell', 'cmd']);
  for (const shell of discovered) {
    assert.equal(typeof shell.label, 'string');
    assert.equal(typeof shell.available, 'boolean');
    if (shell.available) {
      assert.ok(fs.existsSync(shell.path), `${shell.id} must point at a real file`);
      assert.ok(shell.path.toLowerCase().endsWith('.exe'));
    } else {
      assert.equal(shell.path, null);
    }
  }
  if (process.platform === 'win32') {
    const available = discovered.filter((shell) => shell.available).map((shell) => shell.id);
    assert.ok(available.length > 0, 'a Windows machine always has cmd.exe');
  }
});

test('preference order is pwsh, then Windows PowerShell, then cmd', () => {
  const fake = [
    { id: 'pwsh', available: false },
    { id: 'windows-powershell', available: true },
    { id: 'cmd', available: true },
  ];
  assert.equal(shells.preferredShellId(fake), 'windows-powershell');
  assert.equal(shells.preferredShellId([{ id: 'cmd', available: true }]), 'cmd');
  assert.equal(shells.preferredShellId([{ id: 'cmd', available: false }]), null);
});

test('planLaunch carries the argument vector as data and validates the cwd', () => {
  const shell = shells.discoverShells().find((candidate) => candidate.id === 'cmd');
  if (!shell || !shell.available) {
    // Nothing to plan on this machine; the fallback path is still checked.
    assert.equal(shells.planLaunch(null, {}).ok, false);
    assert.equal(shells.planLaunch(null, {}).error, 'SHELL_UNAVAILABLE');
    return;
  }

  const plan = shells.planLaunch(shell, { cwd: 'C:\\no\\such\\folder\\pi-terminal' });
  assert.equal(plan.ok, true);
  assert.equal(plan.path, shell.path);
  assert.deepEqual(plan.args, shell.args);
  assert.equal(plan.cwdNote, 'missing-directory');
  assert.ok(fs.existsSync(plan.cwd), 'the plan always points at a usable directory');

  const gone = shells.planLaunch({ id: 'cmd', available: false, path: null, args: [] }, {});
  assert.equal(gone.ok, false);
});

test('planLaunch never injects a shell command derived from user input', () => {
  const shell = shells.discoverShells().find((candidate) => candidate.id === 'cmd' && candidate.available);
  if (!shell) return;
  const plan = shells.planLaunch(shell, { cwd: 'C:\\Windows & whoami | echo' });
  assert.deepEqual(plan.args, shell.args, 'arguments come from the shell definition only');
  assert.ok(!plan.cwd.includes('&') || plan.cwdNote !== null, 'a bogus directory falls back instead of being executed');
});
