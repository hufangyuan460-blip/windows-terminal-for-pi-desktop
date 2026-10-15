'use strict';

/**
 * helper-probe.cjs — manual diagnostic for the ConPTY helper.
 *
 * Usage:
 *   node tools/helper-probe.cjs <scenario> [scenario...]
 *   node tools/helper-probe.cjs --list
 *
 * It drives the published helper exactly like the plugin does and prints a
 * transcript with a hexdump of any non-ASCII output, so codepage questions can
 * be answered from evidence instead of assumption. Terminal content is printed
 * here on purpose — this tool is a debugging aid, not plugin runtime code.
 */

const path = require('node:path');
const { HelperClient } = require('../lib/helper-client');
const { discoverShells, planLaunch, systemCodePages } = require('../lib/shells');

const HELPER = path.join(__dirname, '..', 'helper', 'bin', 'win-x64', 'pi-conpty-helper.exe');

function decode(buffer, encoding) {
  try {
    return new TextDecoder(encoding).decode(buffer);
  } catch (error) {
    return `<decoder ${encoding} unavailable: ${error.message}>`;
  }
}

function looksBroken(text) {
  return /\uFFFD/.test(text);
}

function hexdump(buffer, limit = 96) {
  const slice = buffer.subarray(0, limit);
  const bytes = [...slice].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  return bytes + (buffer.length > limit ? ` … (+${buffer.length - limit} bytes)` : '');
}

async function runScenario(name, options) {
  const shells = discoverShells();
  const shell = shells.find((entry) => entry.id === options.shellId);
  if (!shell || !shell.available) {
    console.log(`\n### ${name}: skipped (${options.shellId} not installed)`);
    return;
  }

  const launch = planLaunch(shell, {
    cwd: options.cwd || process.cwd(),
    utf8Bootstrap: options.utf8Bootstrap !== false,
  });

  console.log(`\n### ${name}`);
  console.log(`shell   : ${shell.id} -> ${shell.path}`);
  console.log(`args    : ${JSON.stringify(launch.args)}`);
  console.log(`cwd     : ${launch.cwd}`);

  const client = new HelperClient({
    exePath: HELPER,
    log: (message) => console.log(`  [log] ${message}`),
  });

  const collected = [];
  client.on('output', (buffer) => collected.push(buffer));

  let exit = null;
  client.on('exit', (info) => {
    exit = info;
  });

  await client.spawn();
  const ready = await client.start({
    shellPath: launch.path,
    args: launch.args,
    cwd: launch.cwd,
    cols: options.cols || 100,
    rows: options.rows || 30,
  });
  console.log(`ready   : pid=${ready.pid} cols=${ready.cols} rows=${ready.rows}`);

  for (const step of options.steps) {
    collected.length = 0;
    if (step.text !== undefined) {
      await client.input(Buffer.from(step.text, 'utf8'));
    }
    if (step.raw !== undefined) {
      await client.input(Buffer.from(step.raw));
    }
    if (step.resize) {
      await client.resize(step.resize[0], step.resize[1]);
    }
    if (step.wait) {
      await new Promise((resolve) => setTimeout(resolve, step.wait));
    }
    if (step.label) {
      const buffer = Buffer.concat(collected);
      const utf8 = decode(buffer, 'utf-8');
      console.log(`--- ${step.label}`);
      console.log(`    bytes=${buffer.length} utf8=${JSON.stringify(utf8.slice(0, 400))}`);
      if (looksBroken(utf8) || /[\u0080-\uFFFF]/.test(utf8)) {
        console.log(`    hex   = ${hexdump(buffer)}`);
        const gbk = decode(buffer, 'gbk');
        console.log(`    gbk   = ${JSON.stringify(gbk.slice(0, 200))}`);
      }
    }
  }

  await client.close();
  const deadline = Date.now() + 5000;
  while (!exit && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  console.log(`exit    : ${JSON.stringify(exit)}`);
  client.dispose();
}

const SCENARIOS = {
  powershell: {
    shellId: 'windows-powershell',
    steps: [
      { text: 'echo 中文测试\r', wait: 900, label: 'echo CJK through Windows PowerShell' },
      { text: 'Get-Location\r', wait: 700, label: 'location' },
      { text: 'mode con\r', wait: 700, label: 'console size before resize' },
      { resize: [61, 21], wait: 700, label: 'after resize 61x21' },
      { text: 'mode con\r', wait: 700, label: 'console size after resize' },
      { raw: [0x03], wait: 500, label: 'ctrl+c idle' },
      { text: 'echo AFTER_INT\r', wait: 700, label: 'after ctrl+c' },
    ],
  },
  cmd: {
    shellId: 'cmd',
    steps: [
      { text: 'echo 中文测试\r', wait: 900, label: 'echo CJK through cmd' },
      { text: 'chcp\r', wait: 600, label: 'codepage inside the console' },
      { text: 'mode con\r', wait: 600, label: 'console size' },
    ],
  },
  cmd_nobootstrap: {
    shellId: 'cmd',
    utf8Bootstrap: false,
    steps: [
      { text: 'chcp\r', wait: 600, label: 'codepage without bootstrap' },
      { text: 'echo 中文测试\r', wait: 900, label: 'echo CJK without bootstrap' },
    ],
  },
  pwsh: {
    shellId: 'pwsh',
    steps: [
      { text: 'echo 中文测试\r', wait: 900, label: 'echo CJK through pwsh' },
    ],
  },
  interrupt: {
    shellId: 'cmd',
    steps: [
      { text: 'ping -n 30 127.0.0.1\r', wait: 800, label: 'long running command started' },
      { raw: [0x03], wait: 900, label: 'after ctrl+c' },
      { text: 'echo AFTER_INT\r', wait: 800, label: 'after ctrl+c, new command' },
    ],
  },
  powershell: {
    shellId: 'windows-powershell',
    steps: [
      { text: 'echo 中文测试\r', wait: 900, label: 'echo CJK through Windows PowerShell' },
      { text: 'chcp\r', wait: 600, label: 'codepage' },
      { text: 'Get-Location\r', wait: 700, label: 'location' },
      { text: 'mode con\r', wait: 700, label: 'console size before resize' },
      { resize: [61, 21], wait: 900, label: 'after resize 61x21' },
      { text: 'mode con\r', wait: 800, label: 'console size after resize' },
      { raw: [0x03], wait: 600, label: 'ctrl+c idle' },
      { text: 'echo AFTER_INT\r', wait: 800, label: 'after ctrl+c' },
    ],
  },
  powershell_nobootstrap: {
    shellId: 'windows-powershell',
    utf8Bootstrap: false,
    steps: [
      { text: 'echo 中文测试\r', wait: 900, label: 'echo CJK without bootstrap' },
      { text: 'chcp\r', wait: 600, label: 'codepage without bootstrap' },
    ],
  },
};

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--list')) {
    console.log('scenarios: ' + Object.keys(SCENARIOS).join(', '));
    if (args.length === 0) return;
  }

  console.log('code pages: ' + JSON.stringify(systemCodePages()));
  for (const name of args.length ? args.filter((a) => !a.startsWith('--')) : Object.keys(SCENARIOS)) {
    const scenario = SCENARIOS[name];
    if (!scenario) {
      console.log(`unknown scenario: ${name}`);
      continue;
    }
    await runScenario(name, scenario);
  }
}

main().catch((error) => {
  console.error('probe failed: ' + (error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
