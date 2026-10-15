'use strict';

/**
 * self-test.js — the in-app end-to-end smoke test.
 *
 * It is only triggered when `selftest.request` exists in the plugin data
 * directory, because it starts real shells and prints real output. It drives the
 * same code the panel uses (TerminalManager -> helper -> ConPTY -> shell) and
 * writes a JSON report, so "verified in the app on this machine" is a claim with
 * evidence behind it rather than a claim about the environment in general.
 *
 * It never touches the AI, the panel DOM or the host bridge: a failing panel
 * wiring is invisible here, and the report says so.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SELF_TEST_REQUEST = 'selftest.request';
const MARKER = 'PI_WINDOWS_TERMINAL_OK';
const CJK = '中文测试';
const CJK_MARKER = 'PI_CJK_OK';
const INTERRUPT_TARGET = 'ping -n 30 127.0.0.1';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 8000;
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 120;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try {
      value = await predicate();
    } catch {
      value = null;
    }
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await delay(intervalMs);
  }
}

function processExists(pid) {
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

class Recorder {
  constructor() {
    this.checks = [];
  }

  async check(name, run) {
    const started = Date.now();
    try {
      const detail = await run();
      const ok = Boolean(detail && detail.ok !== false);
      this.checks.push({ name, ok, detail: detail === undefined ? null : detail, ms: Date.now() - started });
      return this.checks[this.checks.length - 1];
    } catch (error) {
      this.checks.push({
        name,
        ok: false,
        detail: { error: error && error.message ? error.message : String(error) },
        ms: Date.now() - started,
      });
      return this.checks[this.checks.length - 1];
    }
  }

  get ok() {
    return this.checks.length > 0 && this.checks.every((check) => check.ok);
  }
}

/** Reads everything the tab has produced so far through the polling API. */
function drain(manager, tabId, state) {
  const result = manager.read({ [tabId]: state.cursor }, { maxBytes: 256 * 1024 });
  const entry = result.tabs[tabId];
  if (!entry) return '';
  const parts = [];
  for (const chunk of entry.chunks) {
    parts.push(Buffer.from(chunk.data, 'base64').toString('utf8'));
  }
  if (Number.isFinite(entry.seq)) state.cursor = entry.seq;
  state.text += parts.join('');
  if (state.text.length > 512 * 1024) {
    state.text = state.text.slice(-256 * 1024);
  }
  return state.text;
}

async function runInAppSelfTest(options) {
  const { manager, pluginDir, log } = options;
  const startedAt = new Date();
  const recorder = new Recorder();
  const cwd = options.cwd || process.env.USERPROFILE || process.cwd();

  const environment = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cwd,
    codePage: undefined,
    helperPath: manager.helperPath,
    helperAvailable: manager.helperAvailable(),
    shells: manager.shells.map((shell) => ({ id: shell.id, available: shell.available, path: shell.path })),
    envPathPresent: Boolean(process.env.PATH),
    userProfile: process.env.USERPROFILE || null,
  };

  await recorder.check('shell-discovery', () => ({
    available: manager.shells.filter((shell) => shell.available).map((shell) => shell.id),
    defaultShell: manager.defaultShellId,
  }));

  const targetShell = manager.shells.find((shell) => shell.id === 'cmd' && shell.available)
    || manager.shells.find((shell) => shell.available);
  if (!targetShell) {
    return finish(recorder, startedAt, environment, null, 'no shell available');
  }
  environment.targetShell = targetShell.id;

  const created = manager.create({ shellId: targetShell.id, cwd, cols: 100, rows: 30 });
  if (!created.ok) {
    await recorder.check('create-tab', () => ({ ok: false, error: created.error, message: created.message }));
    return finish(recorder, startedAt, environment, null, 'create failed');
  }

  const tabId = created.tab.id;
  const state = { cursor: 0, text: '' };

  try {
    await recorder.check('session-running', async () => {
      const running = await waitFor(() => {
        const tab = manager.tabs.get(tabId);
        return tab && tab.status === 'running' ? tab : null;
      }, { timeoutMs: 15000 });
      if (!running) {
        const tab = manager.tabs.get(tabId);
        return { ok: false, status: tab ? tab.status : 'missing', error: tab ? tab.error : null };
      }
      drain(manager, tabId, state);
      return { ok: true, pid: running.pid, shell: running.shellPath, cwd: running.cwd, cols: running.cols, rows: running.rows };
    });

    await recorder.check('echo-marker', async () => {
      manager.input(tabId, Buffer.from(`echo ${MARKER}\r`).toString('base64'));
      const found = await waitFor(() => {
        const text = drain(manager, tabId, state);
        return text.includes(MARKER);
      }, { timeoutMs: 10000 });
      return { ok: Boolean(found), bytesSeen: state.text.length };
    });

    await recorder.check('echo-cjk', async () => {
      manager.input(tabId, Buffer.from(`echo ${CJK_MARKER} ${CJK}\r`).toString('base64'));
      const found = await waitFor(() => {
        const text = drain(manager, tabId, state);
        return text.includes(`${CJK_MARKER} ${CJK}`);
      }, { timeoutMs: 10000 });
      return { ok: Boolean(found), expected: `${CJK_MARKER} ${CJK}` };
    });

    await recorder.check('resize', async () => {
      const applied = manager.resize(tabId, 61, 21);
      manager.input(tabId, Buffer.from('mode con\r').toString('base64'));
      const sized = await waitFor(() => {
        const text = drain(manager, tabId, state);
        return /Lines:\s+21/.test(text) && /Columns:\s+61/.test(text);
      }, { timeoutMs: 10000 });
      return { ok: Boolean(sized), applied };
    });

    await recorder.check('interrupt', async () => {
      state.text = '';
      manager.input(tabId, Buffer.from(`${INTERRUPT_TARGET}\r`).toString('base64'));
      const started = await waitFor(() => drain(manager, tabId, state).length > 40, { timeoutMs: 6000 });
      if (!started) return { ok: false, error: 'long command did not start' };
      manager.input(tabId, Buffer.from([0x03]).toString('base64'));
      state.text = '';
      manager.input(tabId, Buffer.from(`echo AFTER_INTERRUPT\r`).toString('base64'));
      const resumed = await waitFor(() => drain(manager, tabId, state).includes('AFTER_INTERRUPT'), { timeoutMs: 10000 });
      return { ok: Boolean(resumed) };
    });

    await recorder.check('poll-transport', async () => {
      const result = manager.read({ [tabId]: 0 }, { maxBytes: 64 * 1024 });
      const entry = result.tabs[tabId];
      return { ok: Boolean(entry && entry.chunks.length > 0), chunks: entry ? entry.chunks.length : 0, bytes: entry ? entry.chunks.reduce((sum, chunk) => sum + chunk.data.length, 0) : 0 };
    });

    await recorder.check('drop-notice-limits', () => {
      const tab = manager.tabs.get(tabId);
      const stats = tab.ring.stats();
      return { ok: stats.bytes <= manager.ringBytes + 64 * 1024, ringBytes: stats.bytes, limit: manager.ringBytes, nextSeq: stats.nextSeq };
    });

    const pidBeforeClose = (manager.tabs.get(tabId) || {}).pid || null;

    await recorder.check('close-cleans-up', async () => {
      await manager.close(tabId);
      const gone = await waitFor(() => !processExists(pidBeforeClose), { timeoutMs: 8000 });
      return { ok: gone === true, pid: pidBeforeClose, pidGone: gone === true };
    });
  } finally {
    if (manager.tabs.has(tabId)) {
      await manager.close(tabId, { silent: true });
    }
  }

  return finish(recorder, startedAt, environment, targetShell, null);
}

function finish(recorder, startedAt, environment, targetShell, fatal) {
  const finishedAt = new Date();
  return {
    ok: recorder.ok && !fatal,
    fatal: fatal || null,
    ranAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    environment,
    targetShellId: targetShell ? targetShell.id : null,
    checks: recorder.checks,
  };
}

/** Writes `selftest.request` next to a plugin data directory. */
function requestSelfTest(dataDir) {
  const file = path.join(dataDir, SELF_TEST_REQUEST);
  fs.writeFileSync(file, new Date().toISOString(), 'utf8');
  return file;
}

module.exports = { runInAppSelfTest, requestSelfTest, SELF_TEST_REQUEST, MARKER, CJK };
