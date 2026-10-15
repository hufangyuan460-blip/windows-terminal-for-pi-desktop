'use strict';

/**
 * Windows ConPTY Terminal — PI-Desktop plugin entry point.
 *
 * This file owns the terminal sessions. The panel is a view: the host bridges
 * panel calls into `onPanelInvoke` below, and terminal output travels back over
 * this process's own 127.0.0.1 event feed (see lib/loopback.js for why the host
 * cannot push it).
 *
 * Everything the panel is allowed to ask for is an explicit channel in
 * `CHANNELS`: there is no "run this" entry, and no channel returns the loopback
 * token except `state`, which is only reachable from this plugin's own panel.
 */

const fs = require('node:fs');
const path = require('node:path');

const { TerminalManager } = require('./lib/session');
const { LoopbackService } = require('./lib/loopback');
const { runInAppSelfTest, SELF_TEST_REQUEST } = require('./lib/self-test');

const PLUGIN_ID = 'io.github.hufangyuan460-blip.windows-terminal';
const SELF_TEST_MARKER = 'selftest.request';
const SELF_TEST_REPORT = 'selftest-report.json';

let manager = null;
let loopback = null;
let workspaceInfo = { cwd: null, cwdNote: null };
let dataDir = null;
let selfTestResult = null;

function log(message) {
  console.log(`[${PLUGIN_ID}] ${message}`);
}

function warn(message) {
  console.error(`[${PLUGIN_ID}] ${message}`);
}

/**
 * The working directory new terminals start in: the primary root of the open
 * project, or the user profile with an explanatory note when no project is
 * open. Measured with `pi.workspace.get()`; the shape is the host's
 * ({ path, name, projectId?, roots? }).
 */
async function resolveWorkspace() {
  try {
    const workspace = await pi.workspace.get();
    const roots = Array.isArray(workspace?.roots) ? workspace.roots : [];
    const primary = roots.find((root) => root && root.primary === true && typeof root.path === 'string')
      || (typeof workspace?.path === 'string' && workspace.path ? { path: workspace.path } : null);
    if (primary && primary.path) {
      return { cwd: primary.path, cwdNote: null, projectName: workspace?.name || null };
    }
    return { cwd: null, cwdNote: 'no-project', projectName: null };
  } catch (error) {
    warn('workspace.get failed: ' + (error && error.message ? error.message : error));
    return { cwd: null, cwdNote: 'no-project', projectName: null };
  }
}

async function readSettings() {
  try {
    const settings = await pi.plugin.getSettings();
    return settings && typeof settings === 'object' ? settings : {};
  } catch (error) {
    warn('plugin.getSettings failed: ' + (error && error.message ? error.message : error));
    return {};
  }
}

async function refreshWorkspace() {
  const next = await resolveWorkspace();
  workspaceInfo = next;
  return next;
}

function panelState(options = {}) {
  const includeTransport = options.includeTransport === true;
  const state = manager.state({
    cwd: workspaceInfo.cwd,
    cwdNote: workspaceInfo.cwdNote,
    includeTransport,
    transport: includeTransport && loopback
      ? { kind: 'sse', port: loopback.port, token: loopback.token, path: '/v1/events' }
      : null,
  });
  state.projectName = workspaceInfo.projectName || null;
  state.selfTest = selfTestResult;
  return state;
}

/** One channel table: every panel request is a named, checked operation. */
const CHANNELS = {
  async state(payload) {
    await refreshWorkspace();
    return panelState({ includeTransport: payload?.needTransport === true });
  },

  shells() {
    manager.refreshShells();
    return { ok: true, catalog: manager.shellsSnapshot(), limits: panelState().limits };
  },

  create(payload) {
    const result = manager.create({
      shellId: payload?.shellId,
      cols: payload?.cols,
      rows: payload?.rows,
      cwd: workspaceInfo.cwd,
    });
    if (!result.ok) return result;
    return { ok: true, tab: result.tab, state: panelState() };
  },

  async close(payload) {
    const result = await manager.close(payload?.tabId);
    return { ...result, state: panelState() };
  },

  async restart(payload) {
    const result = await manager.restart(payload?.tabId);
    return { ...result, state: panelState() };
  },

  input(payload) {
    return manager.input(payload?.tabId, payload?.data);
  },

  resize(payload) {
    return manager.resize(payload?.tabId, payload?.cols, payload?.rows);
  },

  interrupt(payload) {
    return manager.interrupt(payload?.tabId);
  },

  clear(payload) {
    return manager.clear(payload?.tabId);
  },

  read(payload) {
    return manager.read(payload?.cursors, { maxBytes: payload?.maxBytes });
  },

  /** The panel reports which transport actually worked; it is a diagnostic. */
  report(payload) {
    const transport = typeof payload?.transport === 'string' ? payload.transport : 'unknown';
    const detail = typeof payload?.message === 'string' ? payload.message.slice(0, 200) : '';
    log(`panel transport=${transport}${detail ? ' detail=' + detail : ''}`);
    return { ok: true };
  },

  stats() {
    return {
      ok: true,
      manager: manager.stats(),
      loopback: loopback ? loopback.stats() : null,
      workspace: { cwd: workspaceInfo.cwd, cwdNote: workspaceInfo.cwdNote },
      selfTest: selfTestResult,
    };
  },

  /** Used by the in-app smoke test and by anyone debugging the plugin. */
  selftest() {
    if (!selfTestResult) return { ok: false, error: 'NOT_RUN' };
    return { ok: true, report: selfTestResult };
  },

  /**
   * Clipboard access lives here rather than in the panel so the permission this
   * plugin asks for is used by the code that asks for it, and so the panel keeps
   * one auditable channel surface.
   */
  async copyText(payload) {
    const text = typeof payload?.text === 'string' ? payload.text : '';
    if (text.length === 0) return { ok: false, error: 'EMPTY' };
    await pi.clipboard.writeText(text);
    return { ok: true, bytes: text.length };
  },

  async pasteText() {
    const text = await pi.clipboard.readText();
    return { ok: true, text: typeof text === 'string' ? text : '' };
  },
};
async function onLoad() {
  dataDir = await pi.plugin.getDataPath();
  const settings = await readSettings();
  await refreshWorkspace();

  loopback = new LoopbackService({
    log: (message) => log('loopback: ' + message),
    source: {
      listTabs: () => (manager ? manager.listTabs() : []),
      readSince: (tabId, since, limits) => (manager ? manager.read({ [tabId]: since }, limits).tabs[tabId] : null),
    },
  });
  await loopback.start();

  manager = new TerminalManager({
    pluginDir: __dirname,
    log,
    settings,
    publish: (tabId, payload) => {
      if (loopback) loopback.broadcast(tabId, payload);
    },
  });

  await pi.commands.register({
    id: 'windows-terminal.new',
    title: '终端: 新建终端',
    keywords: ['terminal', '终端', 'shell', 'powershell', 'cmd'],
    run: async () => {
      await refreshWorkspace();
      const result = manager.create({ cwd: workspaceInfo.cwd });
      if (!result.ok) {
        await pi.ui.showToast(result.message || '无法新建终端', 'error');
        return;
      }
      await pi.ui.showToast(`已新建终端：${result.tab.shellLabel}`, 'info');
    },
  });

  log(
    `loaded (helper ${manager.helperAvailable() ? 'ok' : 'missing'}, `
    + `shells ${manager.shells.filter((shell) => shell.available).map((shell) => shell.id).join(',') || 'none'}, `
    + `cwd ${workspaceInfo.cwd || '<user profile>'})`,
  );

  void maybeRunSelfTest();
}

async function maybeRunSelfTest() {
  if (!dataDir) return;
  const marker = path.join(dataDir, SELF_TEST_MARKER);
  if (!fs.existsSync(marker)) return;
  try {
    fs.rmSync(marker, { force: true });
  } catch (error) {
    warn('could not clear the self-test marker: ' + (error && error.message ? error.message : error));
  }
  try {
    selfTestResult = await runInAppSelfTest({
      manager,
      pluginDir: __dirname,
      cwd: workspaceInfo.cwd,
      log,
    });
    fs.writeFileSync(path.join(dataDir, SELF_TEST_REPORT), JSON.stringify(selfTestResult, null, 2), 'utf8');
    log('self-test ' + (selfTestResult.ok ? 'PASS' : 'FAIL') + ' (report written)');
  } catch (error) {
    selfTestResult = { ok: false, ranAt: new Date().toISOString(), error: String(error) };
    warn('self-test failed: ' + (error && error.message ? error.message : error));
  }
}

async function onPanelInvoke(channel, payload) {
  const handler = Object.prototype.hasOwnProperty.call(CHANNELS, channel) ? CHANNELS[channel] : null;
  if (!handler) {
    const error = new Error(`unknown channel: ${String(channel)}`);
    error.code = 'UNSUPPORTED';
    throw error;
  }
  return handler(payload && typeof payload === 'object' ? payload : {});
}

async function onUnload() {
  try {
    await pi.commands.unregister('windows-terminal.new');
  } catch (error) {
    warn('command unregister failed: ' + (error && error.message ? error.message : error));
  }
  if (manager) {
    await manager.disposeAll('plugin unloaded');
    manager = null;
  }
  if (loopback) {
    await loopback.stop();
    loopback = null;
  }
  log('unloaded');
}

module.exports = { onLoad, onUnload, onPanelInvoke, SELF_TEST_REQUEST };
