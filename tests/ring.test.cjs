'use strict';

/**
 * ring.test.cjs — the bounded output cache.
 *
 * The interesting behaviour is not "it stores bytes" but what happens at the
 * limit and when a reader asks for a range the cache no longer has.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { OutputRing } = require('../lib/ring');

test('assigns increasing sequence numbers and reads after a cursor', () => {
  const ring = new OutputRing();
  ring.push(Buffer.from('one'));
  ring.push(Buffer.from('two'));
  ring.push(Buffer.from('three'));

  assert.equal(ring.latestSeq, 3);
  const all = ring.readSince(0);
  assert.deepEqual(all.chunks.map((chunk) => chunk.buffer.toString()), ['one', 'two', 'three']);
  assert.equal(all.truncated, false);

  const tail = ring.readSince(1);
  assert.deepEqual(tail.chunks.map((chunk) => chunk.buffer.toString()), ['two', 'three']);
  assert.equal(tail.seq, 3);

  const nothing = ring.readSince(3);
  assert.equal(nothing.chunks.length, 0);
});

test('never exceeds its byte budget and reports what it dropped', () => {
  const ring = new OutputRing({ maxBytes: 1000, maxChunks: 100 });
  for (let index = 0; index < 50; index += 1) {
    ring.push(Buffer.alloc(64, index));
  }

  const stats = ring.stats();
  assert.ok(stats.bytes <= 1000, `bytes ${stats.bytes} should stay within the budget`);
  assert.ok(stats.droppedBytes > 0, 'overflow must be recorded, not hidden');

  const early = ring.readSince(0);
  assert.equal(early.truncated, true, 'a cursor before the oldest chunk means lost output');
  const late = ring.readSince(ring.latestSeq - 1);
  assert.equal(late.truncated, false);
});

test('caps a single read so one reply can never be unbounded', () => {
  const ring = new OutputRing({ maxBytes: 4 * 1024 * 1024 });
  for (let index = 0; index < 200; index += 1) {
    ring.push(Buffer.alloc(1024, index % 251));
  }

  const slice = ring.readSince(0, { maxBytes: 8 * 1024, maxChunks: 32 });
  assert.ok(slice.bytes <= 8 * 1024);
  assert.ok(slice.chunks.length <= 32);
  assert.ok(slice.chunks.length > 0);
});

test('bounds the chunk count as well as the byte count', () => {
  const ring = new OutputRing({ maxBytes: 1024 * 1024, maxChunks: 10 });
  for (let index = 0; index < 100; index += 1) {
    ring.push(Buffer.from('x'));
  }
  assert.equal(ring.stats().chunks, 10);
  assert.equal(ring.stats().droppedChunks, 90);
});

test('clear() drops content but keeps sequence numbers monotonic', () => {
  const ring = new OutputRing();
  ring.push(Buffer.from('a'));
  ring.push(Buffer.from('b'));
  ring.clear();
  assert.equal(ring.stats().bytes, 0);
  const seq = ring.push(Buffer.from('c'));
  assert.equal(seq, 3, 'sequence numbers must not restart, or a resume would replay old output');
  assert.deepEqual(ring.readSince(0).chunks.map((chunk) => chunk.buffer.toString()), ['c']);
});
