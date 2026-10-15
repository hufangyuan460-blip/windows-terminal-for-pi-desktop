'use strict';

/**
 * helper.test.cjs — integration tests for the published ConPTY helper.
 *
 * These start real shells, so they are skipped (with a printed reason) when the
 * executable has not been built yet: `powershell -File tools/build-helper.ps1`.
 *
 * What is checked here is the part that unit tests cannot reach: that a real
 * console is created, that bytes come back in the right encoding, that resize
 * reaches the console, and above all that killing the helper takes the whole
 * shell process tree with it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { HelperClient } = require('../lib/helper-client');

const HELPER = path.join(__dirname, '..', 'helper', 'bin', 'win-x64', 'pi-conpty-helper.exe');
const SHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe');
const available = process.platform === 'win32' && fs.existsSync(HELPER) && fs.existsSync(SHELL);

function skip(reason) {
  if (!available) {
    console.log(`# skipped: ${reason}`);
    return true;
  }
  return false;
}

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

function childPidsOf(parentPid) {
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ParentProcessId=${parentPid}").ProcessId -join ','`,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 },
    );
    return output
      .trim()
      .split(',')
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isFinite(value) && value > 0);
  } catch {
    return [];
  }
}

async function waitUntil(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await delay(100);
  }
}

async function startSession(options = {}) {
  const client = new HelperClient({ exePath: HELPER, log: () => {} });
  const output = [];
  client.on('output', (buffer) => output.push(buffer));
  await client.spawn();
  const ready = await client.start({
    shellPath: options.shellPath || SHELL,
    args: options.args || [],
    cwd: options.cwd || __dirname,
    cols: options.cols || 100,
    rows: options.rows || 30,
  });
  return { client, ready, output, text: () => Buffer.concat(output).toString('utf8') };
}

async function waitForText(session, needle, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (session.text().includes(needle)) return true;
    await delay(120);
  }
  return false;
}

test('helper announces protocol version 1', { skip: skip('helper not built') }, async () => {
  const client = new HelperClient({ exePath: HELPER, log: () => {} });
  const hello = await client.spawn();
  assert.equal(hello.event, 'hello');
  assert.equal(hello.protocol, 1);
  assert.equal(hello.arch, 'x64');
  client.kill();
});

test('starts a shell in the requested directory and returns its output', { skip: skip('helper not built') }, async () => {
  const session = await startSession({ cwd: __dirname });
  try {
    assert.ok(session.ready.pid > 0, 'the helper reports the shell pid');
    assert.equal(session.ready.cols, 100);
    assert.equal(session.ready.rows, 30);

    const okRun = await session.client.input(Buffer.from('echo PI_HELPER_INTEGRATION_OK\r'));
    assert.equal(okRun, true);
    assert.ok(await waitForText(session, 'PI_HELPER_INTEGRATION_OK'), 'the shell must echo the marker');

    await session.client.input(Buffer.from('cd\r'));
    assert.ok(await waitForText(session, path.basename(__dirname)), 'the shell starts in the given directory');
  } finally {
    await session.client.close();
    session.client.dispose();
  }
});

test('carries CJK text through the console unchanged', { skip: skip('helper not built') }, async () => {
  const session = await startSession();
  try {
    await session.client.input(Buffer.from('echo PI_CJK 中文测试\r'));
    assert.ok(await waitForText(session, 'PI_CJK 中文测试'), 'UTF-8 must survive the round trip');
    const bytes = Buffer.concat(session.output);
    assert.ok(bytes.includes(Buffer.from('中文测试', 'utf8')), 'the raw bytes must be the UTF-8 encoding');
  } finally {
    await session.client.close();
    session.client.dispose();
  }
});

test('resize reaches the console', { skip: skip('helper not built') }, async () => {
  const session = await startSession({ cols: 100, rows: 30 });
  try {
    // Resizing a console while its shell is still printing its banner can be
    // dropped, so wait for the first prompt before asking for a new size.
    assert.ok(await waitForText(session, '>', 15000), 'the shell must reach its prompt');

    await session.client.resize(61, 21);
    session.output.length = 0;

    // `mode con` is localized (`行`/`列` here, `Lines`/`Columns` on an English
    // install), so the check reads the two numbers instead of the labels, and
    // asks again if the answer has not arrived yet.
    let sized = false;
    const deadline = Date.now() + 20000;
    while (!sized && Date.now() < deadline) {
      await session.client.input(Buffer.from('mode con\r'));
      sized = await waitUntil(() => {
        const match = /(?:行|Lines)\s*[:：]\s*(\d+)[\s\S]{0,600}?(?:列|Columns)\s*[:：]\s*(\d+)/.exec(session.text());
        return Boolean(match && match[1] === '21' && match[2] === '61');
      }, 4000);
      session.output.length = 0;
    }
    assert.ok(sized, `the console should report 21x61 after resize: ${session.text().slice(-300)}`);
  } finally {
    await session.client.close();
    session.client.dispose();
  }
});


test('interrupt stops a running command and keeps the shell alive', { skip: skip('helper not built') }, async () => {
  const session = await startSession();
  try {
    await session.client.input(Buffer.from('ping -n 60 127.0.0.1\r'));
    await delay(800);
    assert.equal(await session.client.interrupt(), true);
    await session.client.input(Buffer.from('echo PI_AFTER_INTERRUPT\r'));
    assert.ok(await waitForText(session, 'PI_AFTER_INTERRUPT'), 'the prompt must come back after Ctrl+C');
  } finally {
    await session.client.close();
    session.client.dispose();
  }
});

test('reports the shell exit code', { skip: skip('helper not built') }, async () => {
  const session = await startSession();
  try {
    const exit = new Promise((resolve) => session.client.once('exit', resolve));
    await session.client.input(Buffer.from('exit 7\r'));
    const info = await exit;
    assert.equal(info.code, 7, 'the exit code must be the shell\'s own');
  } finally {
    session.client.dispose();
  }
});

test('closing a session leaves no shell behind', { skip: skip('helper not built') }, async () => {
  const session = await startSession();
  const shellPid = session.ready.pid;
  assert.equal(pidExists(shellPid), true);
  await session.client.close();
  session.client.dispose();
  assert.equal(await waitUntil(() => !pidExists(shellPid)), true, 'the shell must be gone after close');
});

test('killing the helper takes the whole shell process tree with it', { skip: skip('helper not built') }, async () => {
  const session = await startSession();
  const shellPid = session.ready.pid;
  try {
    // A child of the shell (a second process in the same console tree).
    await session.client.input(Buffer.from('ping -n 60 127.0.0.1\r'));
    await delay(1200);
    const children = childPidsOf(shellPid);
    assert.ok(children.length > 0, 'the shell should have started a child process');

    // Brutal on purpose: no protocol goodbye, just terminate the helper. The job
    // object is the only thing that can clean up now.
    session.client.kill();

    assert.equal(await waitUntil(() => !pidExists(shellPid), 10000), true, 'the shell must not survive the helper');
    for (const child of children) {
      assert.equal(await waitUntil(() => !pidExists(child), 10000), true, `child process ${child} must not survive`);
    }
  } finally {
    session.client.dispose();
  }
});

test('rejects unknown operations instead of guessing', { skip: skip('helper not built') }, async () => {
  const session = await startSession();
  try {
    await assert.rejects(() => session.client.request('definitely-not-an-op', {}), /unknown op/);
  } finally {
    await session.client.close();
    session.client.dispose();
  }
});
