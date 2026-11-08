/**
 * usage.js - a tiny "data meter": counts how many bytes each kind of download used.
 * Used by the Node server (feed + address downloads) AND by the page (what this device downloads).
 *
 *   const meter = createUsageTracker();
 *   meter.record('realtimeFeed', 13708);     // "a download of this kind just used 13,708 bytes"
 *   meter.snapshot();                         // totals so far, per kind
 *   diffSnapshots(before, after);             // what happened BETWEEN two snapshots (e.g. one 30 s refresh)
 *
 * NOTE: sizes are the size of the data received (after the browser/Node has undone any compression).
 * They do not include HTTP headers/TLS overhead (a few hundred bytes per request), so real usage is a little higher
 * when the data is sent uncompressed, and lower if the sender compressed it.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.PenangLib = root.PenangLib || {}; root.PenangLib.usage = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

function createUsageTracker() {
  let startedAtMs = Date.now();
  let categories = {}; // kind -> { count, bytes, lastBytes, lastAtMs }

  /** Notes that one download of `kind` used `bytes` bytes. */
  function record(kind, bytes) {
    const entry = categories[kind] || (categories[kind] = { count: 0, bytes: 0, lastBytes: 0, lastAtMs: 0 });
    entry.count += 1;
    entry.bytes += bytes;
    entry.lastBytes = bytes;
    entry.lastAtMs = Date.now();
  }

  /** A copy of the counters right now (safe to keep and compare later). */
  function snapshot() {
    const copy = {};
    let totalBytes = 0;
    for (const [kind, entry] of Object.entries(categories)) { copy[kind] = { ...entry }; totalBytes += entry.bytes; }
    return { startedAtMs, nowMs: Date.now(), totalBytes, categories: copy };
  }

  /** Starts counting from zero again. */
  function reset() { startedAtMs = Date.now(); categories = {}; }

  return { record, snapshot, reset };
}

/** What was downloaded between two snapshots: { totalBytes, categories: { kind: bytes } } */
function diffSnapshots(before, after) {
  const categories = {};
  for (const [kind, entry] of Object.entries(after.categories)) {
    const earlier = before.categories[kind] ? before.categories[kind].bytes : 0;
    if (entry.bytes - earlier > 0) categories[kind] = entry.bytes - earlier;
  }
  return { totalBytes: after.totalBytes - before.totalBytes, categories };
}

/** 48419 -> "47.3 KB", 2805926 -> "2.7 MB" */
function formatBytes(bytes) {
  if (bytes < 1024) return Math.round(bytes) + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
  return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

return { createUsageTracker, diffSnapshots, formatBytes };
});
