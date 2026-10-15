'use strict';

// raw-helper-check.cjs — drives the helper with the wire protocol directly and
// prints every raw stdout line, so a missing-output bug can be attributed to
// the helper or to the plugin client.

const path = require('node:path');
const { spawn } = require('node:child_process');

const exe = path.join(__dirname, '..', 'helper', 'bin', 'win-x64', 'pi-conpty-helper.exe');
const child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  for (const line of String(chunk).split('\n')) {
    if (line.trim()) console.log('OUT ' + line.slice(0, 160));
  }
});
child.stderr.on('data', (chunk) => console.log('ERR ' + String(chunk).trim().slice(0, 200)));

const send = (message) => child.stdin.write(JSON.stringify(message) + '\n');

setTimeout(() => {
  console.log('--- start');
  send({
    id: 'r1',
    op: 'start',
    shell: { path: 'C:\\Windows\\System32\\cmd.exe' },
    args: [],
    cwd: process.cwd(),
    cols: 100,
    rows: 30,
  });
}, 300);

setTimeout(() => {
  console.log('--- input');
  send({ id: 'r2', op: 'input', data: Buffer.from('echo HELLO_FROM_HELPER\r').toString('base64') });
}, 2000);

setTimeout(() => {
  console.log('--- close');
  send({ id: 'r3', op: 'close' });
}, 4000);

setTimeout(() => {
  child.kill();
  process.exit(0);
}, 7000);
