'use strict';

/**
 * session.js — the terminal tab manager.
 *
 * One tab owns exactly one helper process, which owns exactly one pseudoconsole
 * and one shell. Tabs outlive the panel: hiding or closing the work panel only
 * drops the event subscriber, so re-opening it resumes the same shells with
 * their output still in the ring buffer.
 *
 * Output is coalesced before it enters the ring (12 ms or 64 KiB, whichever
 * comes first) so a program that prints in thousands of tiny writes does not
 * turn into thousands of frames, and every payload that leaves this module is
 * bounded.
 */

const fs = require('node:fs');
const path = require('node:path');

const { HelperClient } = require('./helper-client');
const { OutputRing } = require('./ring');
const { discoverShells, preferredShellId, planLaunch, describeLaunch } = require('./shells');

const COALESCE_MS = 12;
const COALESCE_BYTES = 64 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RESIZE_DIMENSION = 1000;
const DEFAULT_MAX_TABS = 8;
const RESTART_DELAY_MS = 150;

const HELPERS_ARCHIVE = path.join('helper', 'bin', 'win-x64', 'pi-conpty-helper.exe');

class TerminalManager {
  /**
   * @param {object} options
   * @param {string} options.pluginDir directory the plugin was loaded from
   * @param {(message: string) => void} options.log diagnostics sink
   * @param {object} options.settings plugin settings snapshot
   * @param {(tabId: string, payload: object) => void} options.publish push to panel subscribers
   */
  constructor(options) {
    this.pluginDir = options.pluginDir;
    this.log = options.log;
    this.settings = options.settings || {};
    this.publish = options.publish || (() => {});
    this.tabs = new Map();
    this.order = [];
    this.counter = 1;
    this.disposed = false;
    this.shells = [];
    this.lastShellError = null;
    this.refreshShells();
  }

  get helperPath() {
    return path.join(this.pluginDir, HELPERS_ARCHIVE);
  }

  get maxTabs() {
    const configured = Number(this.settings.maxTabs);
    if (Number.isFinite(configured) && configured >= 1 && configured <= 16) return Math.floor(configured);
    return DEFAULT_MAX_TABS;
  }

  get ringBytes() {
    const kib = Number(this.settings.scrollbackKiB);
    if (Number.isFinite(kib) && kib >= 16 && kib <= 4096) return Math.floor(kib) * 1024;
    return 256 * 1024;
  }

  helperAvailable() {
    try {
      return fs.statSync(this.helperPath).isFile();
    } catch {
      return false;
    }
  }

  refreshShells() {
    this.shells = discoverShells();
    const preferred = preferredShellId(this.shells);
    this.defaultShellId = this.#configuredShellId() || preferred;
    return this.shells;
  }

  #configuredShellId() {
    const configured = typeof this.settings.defaultShell === 'string' ? this.settings.defaultShell : '';
    if (!configured || configured === 'auto') return null;
    const match = this.shells.find((shell) => shell.id === configured && shell.available);
    return match ? match.id : null;
  }

  applySettings(settings) {
    this.settings = settings || {};
    this.refreshShells();
  }

  /** Shell catalog for the panel, plus what the plugin resolved as the default. */
  shellsSnapshot() {
    return {
      defaultShellId: this.defaultShellId,
      helperAvailable: this.helperAvailable(),
      helperPath: this.helperPath,
      shells: this.shells.map((shell) => ({
        id: shell.id,
        label: shell.label,
        available: shell.available,
        path: shell.path,
        detail: shell.detail,
        dialect: shell.dialect,
      })),
    };
  }

  listTabs() {
    return this.order
      .map((id) => this.tabs.get(id))
      .filter(Boolean)
      .map((tab) => this.tabSummary(tab));
  }

  tabSummary(tab) {
    return {
      id: tab.id,
      title: tab.title,
      shellId: tab.shellId,
      shellLabel: tab.shellLabel,
      shellPath: tab.shellPath,
      cwd: tab.cwd,
      cwdNote: tab.cwdNote,
      cols: tab.cols,
      rows: tab.rows,
      status: tab.status,
      exitCode: tab.exitCode,
      error: tab.error,
      pid: tab.pid,
      active: tab.active,
      bytes: tab.ring.stats().totalBytes,
      dropped: tab.ring.stats().droppedBytes,
    };
  }

  /** Full panel snapshot: tabs, shells, defaults and limits. */
  state(options = {}) {
    const includeTransport = options.includeTransport === true;
    return {
      tabs: this.listTabs(),
      shells: this.shellsSnapshot(),
      limits: { maxTabs: this.maxTabs, scrollbackKiB: Math.round(this.ringBytes / 1024) },
      cwd: options.cwd || null,
      cwdNote: options.cwdNote || null,
      transport: includeTransport ? options.transport || null : null,
      notices: options.notices || [],
    };
  }

  create(options = {}) {
    if (this.disposed) return { ok: false, error: 'DISPOSED', message: '终端管理器已关闭' };
    if (!this.helperAvailable()) {
      return {
        ok: false,
        error: 'HELPER_MISSING',
        message: '未找到 ConPTY 辅助程序：' + this.helperPath,
      };
    }
    if (this.order.length >= this.maxTabs) {
      return {
        ok: false,
        error: 'TOO_MANY_TABS',
        message: `已达到终端数量上限（${this.maxTabs}）`,
      };
    }

    this.refreshShells();
    const requested = typeof options.shellId === 'string' && options.shellId ? options.shellId : '';
    const shellId = requested || this.defaultShellId;
    const shell = this.shells.find((candidate) => candidate.id === shellId && candidate.available)
      || this.shells.find((candidate) => candidate.available);
    if (!shell) {
      return { ok: false, error: 'NO_SHELL', message: '没有可用的 Shell' };
    }

    const plan = planLaunch(shell, { cwd: options.cwd });
    if (!plan.ok) {
      return { ok: false, error: plan.error, message: '无法启动 ' + shell.label };
    }

    const id = `t${this.counter++}`;
    const tab = {
      id,
      title: this.#nextTitle(shell.label),
      shellId: shell.id,
      shellLabel: shell.label,
      shellPath: plan.path,
      args: plan.args,
      cwd: plan.cwd,
      cwdNote: plan.cwdNote || null,
      codePage: plan.codePage,
      cols: clampDimension(options.cols, 80),
      rows: clampDimension(options.rows, 24),
      status: 'starting',
      exitCode: null,
      error: null,
      pid: null,
      active: false,
      ring: new OutputRing({ maxBytes: this.ringBytes }),
      client: new HelperClient({
        exePath: this.helperPath,
        log: (message) => this.log(`[${id}] ${message}`),
      }),
      pending: [],
      flushTimer: null,
      pendingBytes: 0,
      createdAt: Date.now(),
      restarts: 0,
      spawnToken: 0,
    };

    this.tabs.set(id, tab);
    this.order.push(id);
    this.#wire(tab);
    this.#spawn(tab);
    this.#emitStatus(tab);
    this.log(`tab ${id} created: ${shell.id} -> ${describeLaunch(plan)} (cwd ${plan.cwd || '<default>'})`);
    return { ok: true, tab: this.tabSummary(tab) };
  }

  #nextTitle(shellLabel) {
    const used = new Set([...this.tabs.values()].map((tab) => tab.title));
    for (let index = 1; index < 100; index += 1) {
      const candidate = `${shellLabel} ${index}`;
      if (!used.has(candidate)) return candidate;
    }
    return shellLabel;
  }

  #wire(tab) {
    const client = tab.client;
    client.on('output', (buffer) => this.#enqueue(tab, buffer));
    client.on('exit', (info) => {
      this.#flush(tab);
      tab.status = 'exited';
      tab.exitCode = info.code;
      if (info.forced) {
        tab.error = 'Shell 进程被终止';
      }
      this.#emitStatus(tab);
      this.log(`[${tab.id}] shell exited code=${info.code}${info.forced ? ' forced' : ''}`);
    });
    client.on('error-event', (event) => {
      tab.status = 'error';
      tab.error = event.message || event.code;
      this.#emitStatus(tab);
      this.log(`[${tab.id}] helper error ${event.code}: ${event.message}`);
    });
    client.on('closed', (info) => {
      this.#flush(tab);
      if (tab.status !== 'exited' && tab.status !== 'error') {
        tab.status = 'error';
        tab.error = `辅助进程意外退出（代码 ${info && Number.isFinite(info.code) ? info.code : -1}）`;
        this.#emitStatus(tab);
      }
      this.log(`[${tab.id}] helper process closed`);
    });
    client.on('failed', (error) => {
      tab.status = 'error';
      tab.error = error && error.message ? error.message : String(error);
      this.#emitStatus(tab);
    });
  }

  async #spawn(tab) {
    const token = (tab.spawnToken += 1);
    tab.status = 'starting';
    tab.exitCode = null;
    try {
      await tab.client.spawn();
      if (this.disposed || tab.spawnToken !== token) return;
      const reply = await tab.client.start({
        shellPath: tab.shellPath,
        args: tab.args,
        cwd: tab.cwd,
        cols: tab.cols,
        rows: tab.rows,
      });
      if (this.disposed || tab.spawnToken !== token) return;
      tab.pid = Number.isFinite(reply.pid) ? reply.pid : null;
      tab.status = 'running';
      tab.error = null;
      this.#emitStatus(tab);
      this.log(`[${tab.id}] shell running pid=${tab.pid}`);
    } catch (error) {
      if (this.disposed || tab.spawnToken !== token) return;
      tab.status = 'error';
      tab.error = error && error.message ? error.message : String(error);
      this.#emitStatus(tab);
      this.log(`[${tab.id}] start failed: ${tab.error}`);
    }
  }

  #enqueue(tab, buffer) {
    tab.pending.push(buffer);
    tab.pendingBytes += buffer.length;
    if (tab.pendingBytes >= COALESCE_BYTES) {
      this.#flush(tab);
      return;
    }
    if (!tab.flushTimer) {
      tab.flushTimer = setTimeout(() => {
        tab.flushTimer = null;
        this.#flush(tab);
      }, COALESCE_MS);
      if (typeof tab.flushTimer.unref === 'function') tab.flushTimer.unref();
    }
  }

  #flush(tab) {
    if (tab.flushTimer) {
      clearTimeout(tab.flushTimer);
      tab.flushTimer = null;
    }
    if (tab.pending.length === 0) return;
    const buffer = tab.pending.length === 1 ? tab.pending[0] : Buffer.concat(tab.pending, tab.pendingBytes);
    tab.pending = [];
    tab.pendingBytes = 0;
    if (buffer.length === 0) return;
    const seq = tab.ring.push(buffer);
    const before = tab.ring.stats();
    this.publish(tab.id, {
      kind: 'output',
      tabId: tab.id,
      seq,
      data: buffer.toString('base64'),
    });
    if (before.droppedBytes > 0 && before.droppedBytes !== tab.lastDropNotice) {
      tab.lastDropNotice = before.droppedBytes;
      this.publish(tab.id, {
        kind: 'notice',
        tabId: tab.id,
        code: 'OUTPUT_DROPPED',
        droppedBytes: before.droppedBytes,
      });
    }
  }

  #emitStatus(tab) {
    this.publish(tab.id, { kind: 'status', tabId: tab.id, tab: this.tabSummary(tab) });
  }

  input(tabId, base64) {
    const tab = this.#tab(tabId);
    if (!tab) return { ok: false, error: 'NO_TAB' };
    if (typeof base64 !== 'string' || base64.length === 0) return { ok: false, error: 'EMPTY' };
    if (base64.length > Math.ceil((MAX_INPUT_BYTES * 4) / 3) + 8) {
      return { ok: false, error: 'TOO_LARGE', message: '输入过大' };
    }
    let buffer;
    try {
      buffer = Buffer.from(base64, 'base64');
    } catch {
      return { ok: false, error: 'BAD_PAYLOAD' };
    }
    if (buffer.length === 0) return { ok: false, error: 'EMPTY' };
    tab.client.input(buffer).catch(() => {});
    return { ok: true, bytes: buffer.length };
  }

  resize(tabId, cols, rows) {
    const tab = this.#tab(tabId);
    if (!tab) return { ok: false, error: 'NO_TAB' };
    const nextCols = clampDimension(cols, tab.cols);
    const nextRows = clampDimension(rows, tab.rows);
    if (nextCols === tab.cols && nextRows === tab.rows) return { ok: true, cols: nextCols, rows: nextRows };
    tab.cols = nextCols;
    tab.rows = nextRows;
    tab.client.resize(nextCols, nextRows).catch(() => {});
    this.#emitStatus(tab);
    return { ok: true, cols: nextCols, rows: nextRows };
  }

  interrupt(tabId) {
    const tab = this.#tab(tabId);
    if (!tab) return { ok: false, error: 'NO_TAB' };
    tab.client.interrupt().catch(() => {});
    return { ok: true };
  }

  clear(tabId) {
    const tab = this.#tab(tabId);
    if (!tab) return { ok: false, error: 'NO_TAB' };
    tab.ring.clear();
    return { ok: true };
  }

  async close(tabId, options = {}) {
    const tab = this.#tab(tabId);
    if (!tab) return { ok: false, error: 'NO_TAB' };
    this.#flush(tab);
    this.tabs.delete(tabId);
    this.order = this.order.filter((id) => id !== tabId);
    tab.spawnToken += 1;
    try {
      await tab.client.close();
    } catch {
      // ignored
    }
    const deadline = Date.now() + 3000;
    while (!tab.client.exited && Date.now() < deadline) {
      await delay(50);
    }
    if (!tab.client.exited) {
      tab.client.kill();
    }
    tab.client.dispose();
    this.publish(tabId, { kind: 'closed', tabId });
    if (!options.silent) this.log(`tab ${tabId} closed`);
    return { ok: true };
  }

  async restart(tabId) {
    const tab = this.#tab(tabId);
    if (!tab) return { ok: false, error: 'NO_TAB' };
    this.#flush(tab);
    tab.spawnToken += 1;
    tab.restarts += 1;
    const token = tab.spawnToken;
    try {
      await tab.client.close();
    } catch {
      // ignored
    }
    const deadline = Date.now() + 3000;
    while (!tab.client.exited && Date.now() < deadline) {
      await delay(50);
    }
    if (!tab.client.exited) tab.client.kill();
    tab.client.dispose();
    await delay(RESTART_DELAY_MS);
    if (this.disposed || tab.spawnToken !== token) return { ok: true, restarted: false };

    tab.ring = new OutputRing({ maxBytes: this.ringBytes });
    tab.client = new HelperClient({
      exePath: this.helperPath,
      log: (message) => this.log(`[${tab.id}] ${message}`),
    });
    tab.status = 'starting';
    tab.error = null;
    tab.exitCode = null;
    tab.pid = null;
    this.#wire(tab);
    this.#spawn(tab);
    this.#emitStatus(tab);
    this.log(`tab ${tabId} restarted`);
    return { ok: true, restarted: true };
  }

  /**
   * Poll fallback: returns everything after each cursor, bounded per reply.
   * `cursors` maps tabId -> last sequence the panel already wrote.
   */
  read(cursors, options = {}) {
    const maxBytes = Number.isFinite(options.maxBytes) ? Math.min(Math.max(options.maxBytes, 1024), 512 * 1024) : 192 * 1024;
    const perTab = Math.max(8 * 1024, Math.floor(maxBytes / Math.max(1, this.order.length)));
    const result = {};
    for (const [tabId, tab] of this.tabs) {
      const since = cursors && Number.isFinite(Number(cursors[tabId])) ? Number(cursors[tabId]) : 0;
      const slice = tab.ring.readSince(since, { maxBytes: perTab, maxChunks: 256 });
      result[tabId] = {
        seq: slice.seq,
        chunks: slice.chunks.map((chunk) => ({ seq: chunk.seq, data: chunk.buffer.toString('base64') })),
        truncated: slice.truncated,
        droppedBytes: slice.droppedBytes,
        status: tab.status,
        exitCode: tab.exitCode,
        error: tab.error,
        cols: tab.cols,
        rows: tab.rows,
      };
    }
    return { ok: true, tabs: result };
  }

  stats() {
    const tabs = [...this.tabs.values()].map((tab) => ({
      id: tab.id,
      status: tab.status,
      pid: tab.pid,
      ring: tab.ring.stats(),
      restarts: tab.restarts,
    }));
    return { tabs, count: tabs.length, helper: this.helperPath, helperAvailable: this.helperAvailable() };
  }

  async disposeAll(reason = 'plugin unloaded') {
    this.disposed = true;
    const ids = [...this.order];
    await Promise.all(ids.map((id) => this.close(id, { silent: true })));
    for (const tab of this.tabs.values()) {
      tab.client.kill();
    }
    this.tabs.clear();
    this.order = [];
    this.log(`all terminals disposed (${reason}); ${ids.length} closed`);
    return ids.length;
  }

  #tab(tabId) {
    return typeof tabId === 'string' ? this.tabs.get(tabId) || null : null;
  }
}

function clampDimension(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 2) return fallback;
  return Math.min(MAX_RESIZE_DIMENSION, Math.max(2, Math.floor(number)));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { TerminalManager, MAX_INPUT_BYTES, MAX_RESIZE_DIMENSION };
