'use strict';

/**
 * helper-client.js — the plugin side of the ConPTY helper protocol.
 *
 * One client wraps one helper process and therefore exactly one terminal
 * session: a tab is a helper is a shell. The wire format is JSON Lines, and
 * terminal payload travels as base64 of raw bytes in both directions so that
 * a character split across two console reads is never corrupted.
 *
 * Nothing here logs terminal data: diagnostics carry counts and ids only.
 */

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const PROTOCOL_VERSION = 1;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const START_TIMEOUT_MS = 20000;
const STDERR_TAIL_LINES = 40;

class HelperClient extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.exePath absolute path to pi-conpty-helper.exe
   * @param {(message: string) => void} [options.log] diagnostic sink (never terminal data)
   */
  constructor(options) {
    super();
    this.exePath = options.exePath;
    this.log = typeof options.log === 'function' ? options.log : () => {};
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBuffer = '';
    this.stderrTail = [];
    this.exited = false;
    this.exitInfo = null;
    this.disposed = false;
  }

  /** Spawns the helper and resolves once it has announced its protocol. */
  async spawn() {
    if (this.child) throw new Error('helper already spawned');
    const child = spawn(this.exePath, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: {
        SystemRoot: process.env.SystemRoot || 'C:\\Windows',
        windir: process.env.windir || process.env.SystemRoot || 'C:\\Windows',
        TEMP: process.env.TEMP || '',
        TMP: process.env.TMP || process.env.TEMP || '',
        PATH: process.env.PATH || '',
        USERPROFILE: process.env.USERPROFILE || '',
      },
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr.on('data', (chunk) => this.#onStderr(chunk));
    child.on('error', (error) => {
      this.log('helper spawn error: ' + error.message);
      this.emit('failed', error);
    });
    child.on('exit', (code, signal) => {
      this.exited = true;
      this.exitInfo = { code: code === null ? -1 : code, signal: signal || null };
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('helper exited before replying'));
      }
      this.pending.clear();
      this.emit('closed', this.exitInfo);
    });

    const hello = await this.#firstEvent(5000);
    if (!hello || hello.event !== 'hello') {
      throw new Error('helper did not announce its protocol');
    }
    if (Number(hello.protocol) !== PROTOCOL_VERSION) {
      throw new Error(`unsupported helper protocol ${hello.protocol}`);
    }
    this.hello = hello;
    return hello;
  }

  /** Asks the helper to create the pseudoconsole and the shell process. */
  async start(options) {
    const reply = await this.request(
      'start',
      {
        shell: { path: options.shellPath },
        args: Array.isArray(options.args) ? options.args : [],
        cwd: options.cwd || '',
        cols: options.cols || 80,
        rows: options.rows || 24,
        env: options.env || {},
      },
      START_TIMEOUT_MS,
    );
    return reply;
  }

  async input(bytes) {
    if (this.disposed || this.exited) return false;
    try {
      await this.request('input', { data: Buffer.from(bytes).toString('base64') });
      return true;
    } catch (error) {
      this.log('input failed: ' + error.message);
      return false;
    }
  }

  async resize(cols, rows) {
    if (this.disposed || this.exited) return false;
    try {
      await this.request('resize', { cols, rows });
      return true;
    } catch (error) {
      this.log('resize failed: ' + error.message);
      return false;
    }
  }

  async interrupt() {
    if (this.disposed || this.exited) return false;
    try {
      await this.request('signal', { name: 'int' });
      return true;
    } catch (error) {
      this.log('interrupt failed: ' + error.message);
      return false;
    }
  }

  /** Terminates the shell tree and lets the helper report the exit. */
  async close() {
    if (!this.child || this.exited) return;
    try {
      await this.request('close', {}, 5000);
    } catch (error) {
      this.log('close failed: ' + error.message);
    }
  }

  /** Last resort: kill the helper process itself. The shell dies with it. */
  kill() {
    if (this.exited) return;
    try {
      this.child?.kill();
    } catch (error) {
      this.log('helper kill failed: ' + error.message);
    }
  }

  dispose() {
    this.disposed = true;
    this.stdin = null;
    try {
      this.child?.stdin?.end();
    } catch {
      // ignored
    }
  }

  request(op, payload, timeoutMs = 15000) {
    if (!this.child || this.exited) {
      return Promise.reject(new Error('helper is not running'));
    }
    const id = `r${this.nextId++}`;
    const message = JSON.stringify({ id, op, ...payload });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${op} timed out`));
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      this.pending.set(id, { resolve, reject, timer, op });
      try {
        this.child.stdin.write(message + '\n');
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  #firstEvent(timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.removeListener('event', onEvent);
        reject(new Error('helper handshake timed out'));
      }, timeoutMs);
      const onEvent = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
      this.once('event', onEvent);
    });
  }

  #onStdout(chunk) {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_LINE_BYTES) {
      this.log('helper output line exceeded the limit; closing the session');
      this.stdoutBuffer = '';
      this.kill();
      return;
    }
    let index = this.stdoutBuffer.indexOf('\n');
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.trim().length > 0) {
        this.#handleLine(line);
      }
      index = this.stdoutBuffer.indexOf('\n');
    }
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log('helper sent a malformed protocol line');
      return;
    }

    if (message.event === 'output' && typeof message.data === 'string') {
      this.emit('output', Buffer.from(message.data, 'base64'));
      return;
    }

    if (message.event === 'exit') {
      this.emit('exit', {
        code: Number.isFinite(message.code) ? message.code : -1,
        forced: message.forced === true,
      });
      return;
    }

    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.event === 'error') {
        const error = new Error(message.message || 'helper request failed');
        error.code = message.code || 'HELPER_ERROR';
        entry.reject(error);
      } else {
        entry.resolve(message);
      }
      return;
    }

    if (message.event === 'error') {
      this.emit('error-event', { code: message.code || 'HELPER_ERROR', message: message.message || '' });
      return;
    }

    this.emit('event', message);
  }

  #onStderr(chunk) {
    const text = String(chunk);
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      this.stderrTail.push(line);
      if (this.stderrTail.length > STDERR_TAIL_LINES) this.stderrTail.shift();
      this.log('helper: ' + line);
    }
  }
}

module.exports = { HelperClient, PROTOCOL_VERSION };
