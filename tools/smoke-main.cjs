'use strict';

// Minimal headless smoke of the plugin entry, with progress prints, used while
// debugging test hangs. Not part of the suite.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN = path.join(__dirname, '..', 'main.js');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-smoke-'));
const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-proj-'));

globalThis.pi = {
  plugin: { getDataPath: async () => dataDir, getSettings: async () => ({}), setSettings: async () => {} },
  workspace: { get: async () => ({ path: workspacePath, roots: [{ path: workspacePath, primary: true }] }) },
  commands: { register: async () => {}, unregister: async () => {} },
  ui: { showToast: async () => {} },
  clipboard: { readText: async () => 'clip', writeText: async () => {} },
};

function step(message) {
  console.log('STEP', message);
}

(async () => {
  step('requiring plugin');
  const plugin = require(PLUGIN);
  step('onLoad');
  await plugin.onLoad();
  step('state');
  const state = await plugin.onPanelInvoke('state', { needTransport: true });
  step('state tabs=' + state.tabs.length + ' port=' + (state.transport ? state.transport.port : 'none'));
  step('create');
  const created = await plugin.onPanelInvoke('create', { shellId: 'cmd' });
  step('create ok=' + created.ok + ' tab=' + (created.tab ? created.tab.id : 'none'));
  for (let index = 0; index < 30; index += 1) {
    const current = await plugin.onPanelInvoke('state', {});
    const tab = current.tabs[0];
    if (tab && tab.status === 'running') {
      step('running pid=' + tab.pid);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  step('unload');
  await plugin.onUnload();
  step('done');
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workspacePath, { recursive: true, force: true });
  process.exit(0);
})().catch((error) => {
  console.error('SMOKE FAILED', error);
  process.exit(1);
});
