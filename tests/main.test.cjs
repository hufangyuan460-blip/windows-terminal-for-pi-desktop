'use strict';

/**
 * main.test.cjs — the plugin entry point, headless.
 *
 * PI-Desktop is not involved: the host API the plugin expects (`globalThis.pi`)
 * is stubbed, and everything else is the real code — the channel table, the
 * terminal manager, the helper process, the loopback service. This is what makes
 * it possible to say "the panel surface works" without a running app; the parts
 * it cannot reach (the DOM, the host bridge transport) are listed in the test
 * report instead of quietly assumed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PLUGIN_DIR = path.join(__dirname, '..');
const HELPER = path.join(PLUGIN_DIR, 'helper', 'bin', 'win-x64', 'pi-conpty-helper.exe');

const available = process.platform === 'win32' && fs.existsSync(HELPER);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pidExists(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    const output = execFileSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    });
    return output.includes(`"${pid}"`);
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await delay(120);
  }
}

/** Minimal stand-in for the host-injected `pi` object. */
function installHostStub(dataDir, workspacePath) {
  const state = { toasts: [], clipboard: 'from-the-clipboard' };
  globalThis.pi = {
    app: { getVersion: async () => '0.17.0', getLocale: async () => 'zh-CN', getAppearance: async () => ({ base: 'dark', locale: 'zh-CN' }) },
    plugin: {
      getId: () => 'io.github.hufangyuan460-blip.windows-terminal',
      getDataPath: async () => dataDir,
      getSettings: async () => ({}),
      setSettings: async () => {},
    },
    workspace: { get: async () => ({ path: workspacePath, name: 'fixture', roots: [{ path: workspacePath, primary: true }] }) },
    commands: { register: async () => {}, unregister: async () => {} },
    ui: { showToast: async (message) => state.toasts.push(message), openPanel: async () => {}, closePanel: async () => {} },
    clipboard: {
      readText: async () => state.clipboard,
      writeText: async (text) => {
        state.clipboard = text;
      },
    },
  };
  return state;
}

async function withPlugin(run) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-terminal-data-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-terminal-project-'));
  const host = installHostStub(dataDir, workspacePath);
  const plugin = require(path.join(PLUGIN_DIR, 'main.js'));
  await plugin.onLoad();
  try {
    await run({ plugin, host, dataDir, workspacePath });
  } finally {
    try {
      await plugin.onUnload();
    } catch {
      // unloading twice must not throw either; the assertion is in its own test
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
}

test('loads, exposes the panel channels and unloads cleanly', { skip: !available && 'helper not built' }, async () => {
  await withPlugin(async ({ plugin, workspacePath }) => {
    const state = await plugin.onPanelInvoke('state', { needTransport: true });
    assert.deepEqual(state.tabs, []);
    assert.equal(state.shells.helperAvailable, true);
    assert.equal(state.shells.shells.length, 3);
    assert.equal(state.transport.kind, 'sse');
    assert.ok(state.transport.port > 1023);
    assert.ok(state.transport.token.length >= 32);
    assert.equal(state.cwd, workspacePath, 'terminals start in the project root');

    const shells = await plugin.onPanelInvoke('shells', {});
    assert.equal(shells.ok, true);
    assert.equal(shells.catalog.shells.filter((shell) => shell.available).length > 0, true);

    await assert.rejects(() => plugin.onPanelInvoke('rm -rf', {}), /unknown channel/);
  });
});

test('creates a tab, runs a command, reads it back and closes it', { skip: !available && 'helper not built' }, async () => {
  await withPlugin(async ({ plugin }) => {
    const created = await plugin.onPanelInvoke('create', { shellId: 'cmd' });
    assert.equal(created.ok, true);
    const tabId = created.tab.id;

    const running = await waitUntil(async () => {
      const current = await plugin.onPanelInvoke('state', {});
      const tab = current.tabs.find((entry) => entry.id === tabId);
      return tab && tab.status === 'running' ? tab : null;
    });
    assert.ok(running, 'the tab must reach the running state');
    assert.ok(running.pid > 0);

    await plugin.onPanelInvoke('input', { tabId, data: Buffer.from('echo PI_MAIN_OK\r').toString('base64') });

    const text = await waitUntil(async () => {
      const reply = await plugin.onPanelInvoke('read', { cursors: {}, maxBytes: 262144 });
      const entry = reply.tabs[tabId];
      const collected = (entry.chunks || []).map((chunk) => Buffer.from(chunk.data, 'base64').toString('utf8')).join('');
      return collected.includes('PI_MAIN_OK') ? collected : null;
    });
    assert.ok(text, 'output must be readable through the panel channel');

    const resized = await plugin.onPanelInvoke('resize', { tabId, cols: 90, rows: 25 });
    assert.equal(resized.ok, true);
    assert.equal(resized.cols, 90);

    const interrupted = await plugin.onPanelInvoke('interrupt', { tabId });
    assert.equal(interrupted.ok, true);

    const pid = running.pid;
    const closed = await plugin.onPanelInvoke('close', { tabId });
    assert.equal(closed.ok, true);
    assert.equal(closed.state.tabs.length, 0);
    const gone = await waitUntil(async () => !pidExists(pid), 10000);
    assert.equal(gone, true, 'closing a tab must not leave the shell running');
  });
});

test('restart replaces the shell and keeps a usable tab', { skip: !available && 'helper not built' }, async () => {
  await withPlugin(async ({ plugin }) => {
    const created = await plugin.onPanelInvoke('create', { shellId: 'cmd' });
    const tabId = created.tab.id;
    const firstPid = await waitUntil(async () => {
      const current = await plugin.onPanelInvoke('state', {});
      const tab = current.tabs.find((entry) => entry.id === tabId);
      return tab && tab.status === 'running' && tab.pid ? tab.pid : null;
    });
    assert.ok(firstPid);

    const restarted = await plugin.onPanelInvoke('restart', { tabId });
    assert.equal(restarted.ok, true);
    const secondPid = await waitUntil(async () => {
      const current = await plugin.onPanelInvoke('state', {});
      const tab = current.tabs.find((entry) => entry.id === tabId);
      return tab && tab.status === 'running' && tab.pid && tab.pid !== firstPid ? tab.pid : null;
    });
    assert.ok(secondPid, 'restart must produce a new shell process');
    assert.equal(await waitUntil(async () => !pidExists(firstPid), 10000), true, 'the old shell must be gone');
  });
});

test('clipboard channels use the granted permissions', { skip: !available && 'helper not built' }, async () => {
  await withPlugin(async ({ plugin, host }) => {
    const copied = await plugin.onPanelInvoke('copyText', { text: 'hello-terminal' });
    assert.equal(copied.ok, true);
    assert.equal(host.clipboard, 'hello-terminal');
    const pasted = await plugin.onPanelInvoke('pasteText', {});
    assert.equal(pasted.ok, true);
    assert.equal(pasted.text, 'hello-terminal');
  });
});

test('enforces the tab limit and reports it instead of failing silently', { skip: !available && 'helper not built' }, async () => {
  await withPlugin(async ({ plugin }) => {
    const results = [];
    for (let index = 0; index < 9; index += 1) {
      results.push(await plugin.onPanelInvoke('create', { shellId: 'cmd' }));
    }
    const refused = results.filter((result) => !result.ok);
    assert.equal(refused.length >= 1, true, 'the ninth tab must be refused');
    assert.equal(refused[0].error, 'TOO_MANY_TABS');
    assert.match(refused[0].message, /上限|limit/i);
    const state = await plugin.onPanelInvoke('state', {});
    assert.ok(state.tabs.length <= 8, 'the limit must be respected');
  });
});

test('unload stops the loopback listener and kills every shell', { skip: !available && 'helper not built' }, async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-terminal-data-'));
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-terminal-project-'));
  installHostStub(dataDir, workspacePath);
  const plugin = require(path.join(PLUGIN_DIR, 'main.js'));
  await plugin.onLoad();
  const created = await plugin.onPanelInvoke('create', { shellId: 'cmd' });
  const pid = await waitUntil(async () => {
    const current = await plugin.onPanelInvoke('state', {});
    const tab = current.tabs.find((entry) => entry.id === created.tab.id);
    return tab && tab.status === 'running' && tab.pid ? tab.pid : null;
  });
  const state = await plugin.onPanelInvoke('state', { needTransport: true });
  const port = state.transport.port;
  assert.ok(pid > 0);

  await plugin.onUnload();

  assert.equal(await waitUntil(async () => !pidExists(pid), 10000), true, 'unload must kill the shell');
  let refused = false;
  try {
    await fetch(`http://127.0.0.1:${port}/v1/state`);
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'the loopback listener must be gone after unload');

  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspacePath, { recursive: true, force: true });
});
