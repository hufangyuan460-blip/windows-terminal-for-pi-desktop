'use strict';

/**
 * ring.js — bounded, sequence-numbered terminal output cache.
 *
 * Every chunk of console output gets a monotonic sequence number, so a panel
 * that reconnects (or that falls back to polling) can ask for "everything after
 * seq N" instead of guessing. The cache is bounded in bytes and in chunk count:
 * when it overflows, the oldest chunks are dropped and the loss is reported
 * rather than silently hidden, because a terminal that quietly forgets output is
 * worse than one that says it did.
 *
 * Nothing here converts or inspects the payload: chunks stay raw bytes.
 */

const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_CHUNKS = 4096;

class OutputRing {
  constructor(options = {}) {
    this.maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
      ? Math.floor(options.maxBytes)
      : DEFAULT_MAX_BYTES;
    this.maxChunks = Number.isFinite(options.maxChunks) && options.maxChunks > 0
      ? Math.floor(options.maxChunks)
      : DEFAULT_MAX_CHUNKS;
    this.chunks = [];
    this.bytes = 0;
    this.nextSeq = 1;
    this.droppedBytes = 0;
    this.droppedChunks = 0;
    this.totalBytes = 0;
  }

  /** Appends raw bytes; returns the sequence number assigned to them. */
  push(buffer) {
    if (!buffer || buffer.length === 0) return this.nextSeq - 1;
    const seq = this.nextSeq++;
    this.chunks.push({ seq, buffer });
    this.bytes += buffer.length;
    this.totalBytes += buffer.length;
    this.#trim();
    return seq;
  }

  #trim() {
    while (this.chunks.length > this.maxChunks || this.bytes > this.maxBytes) {
      if (this.chunks.length <= 1) break;
      const removed = this.chunks.shift();
      this.bytes -= removed.buffer.length;
      this.droppedBytes += removed.buffer.length;
      this.droppedChunks += 1;
    }
  }

  /** Sequence number of the newest chunk (0 when nothing was ever written). */
  get latestSeq() {
    return this.chunks.length > 0 ? this.chunks[this.chunks.length - 1].seq : 0;
  }

  /** Sequence number of the oldest retained chunk (0 when empty). */
  get oldestSeq() {
    return this.chunks.length > 0 ? this.chunks[0].seq : 0;
  }

  /**
   * Everything after `since` (exclusive), capped by `maxBytes`/`maxChunks` so a
   * single reply can never be unbounded. `truncated` says the caller missed
   * output that the cache already dropped.
   */
  readSince(since, options = {}) {
    const from = Number.isFinite(since) ? Math.max(0, Math.floor(since)) : 0;
    const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(1024, options.maxBytes) : 192 * 1024;
    const maxChunks = Number.isFinite(options.maxChunks) ? Math.max(1, options.maxChunks) : 256;
    const truncated = this.droppedChunks > 0 && from < this.oldestSeq;
    const result = [];
    let bytes = 0;
    for (const chunk of this.chunks) {
      if (chunk.seq <= from) continue;
      if (result.length >= maxChunks) break;
      if (bytes + chunk.buffer.length > maxBytes && result.length > 0) break;
      result.push(chunk);
      bytes += chunk.buffer.length;
      if (bytes >= maxBytes) break;
    }
    return {
      chunks: result,
      bytes,
      truncated,
      droppedBytes: this.droppedBytes,
      seq: this.latestSeq,
      oldestSeq: this.oldestSeq,
    };
  }

  clear() {
    this.chunks = [];
    this.bytes = 0;
  }

  stats() {
    return {
      chunks: this.chunks.length,
      bytes: this.bytes,
      totalBytes: this.totalBytes,
      nextSeq: this.nextSeq,
      droppedBytes: this.droppedBytes,
      droppedChunks: this.droppedChunks,
    };
  }
}

module.exports = { OutputRing, DEFAULT_MAX_BYTES, DEFAULT_MAX_CHUNKS };
