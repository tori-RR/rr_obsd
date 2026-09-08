'use strict';

const path = require('node:path');
const nativeFs = require('node:fs').promises;

/** Accept vault-relative paths only. Do not case-fold: case-only renames matter. */
function normalizeRelativePath(value) {
  if (typeof value !== 'string' || /[\x00-\x1f]/.test(value)) return null;
  const slashed = value.replace(/\\/g, '/');
  if (!slashed || slashed.startsWith('/') || /^[a-z]:/i.test(slashed)) return null;
  const segments = slashed.split('/').filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === '..' || segment.includes(':') ||
    (segment !== '.' && /[. ]$/.test(segment)))) return null;
  const normalized = segments.filter((segment) => segment !== '.').join('/');
  return normalized || null;
}

function defaultIgnorePath(relativePath) {
  return relativePath.split('/').some((segment) => segment.startsWith('.'));
}

function depth(value) {
  return value.split('/').length;
}

/**
 * Read-only, serialized reconciliation of external file events.
 *
 * applyPath(relativePath, { isCurrent }) must await the host's real index API,
 * checking isCurrent() again INSIDE any host queue before it mutates the index.
 * getLoadedPaths() returns the host's current file AND folder paths.
 * The injected fs needs promises.readdir/lstat; file contents are never read.
 * A failed complete enumeration never produces a partial reconciliation plan.
 */
class Reconciler {
  constructor({ root, applyPath, getLoadedPaths, fs = nativeFs, onStatus = () => {},
    debounceMs = 150, ignorePath = defaultIgnorePath } = {}) {
    if (typeof root !== 'string' || !root) throw new TypeError('A vault root is required.');
    if (typeof applyPath !== 'function' || typeof getLoadedPaths !== 'function') {
      throw new TypeError('applyPath and getLoadedPaths callbacks are required.');
    }
    this.root = path.resolve(root);
    this.applyPath = applyPath;
    this.getLoadedPaths = getLoadedPaths;
    this.fs = fs;
    this.onStatus = onStatus;
    this.ignorePath = ignorePath;
    this.debounceMs = Math.max(0, Number(debounceMs) || 0);
    this.running = false;
    this.online = false;
    this._epoch = 0;
    this._pending = new Set();
    this._timer = null;
    this._tail = Promise.resolve(false);
    this._lastQueued = this._tail;
    this._scan = null;
    this._scanAgain = null;
    this._observed = new Map();
  }

  start() {
    if (this.running && this.online) return this._lastQueued;
    this.running = true;
    this.online = true;
    this._epoch += 1;
    return this.rescan('startup');
  }

  stop() {
    this.running = false;
    this.online = false;
    this._invalidate();
    this._status({ state: 'stopped' });
  }

  /** Call true only after the replacement native watcher is attached. */
  setOnline(online) {
    if (!this.running || this.online === Boolean(online)) return Promise.resolve(false);
    this.online = Boolean(online);
    this._invalidate();
    if (!this.online) {
      this._status({ state: 'offline' });
      return Promise.resolve(false);
    }
    return this.rescan('reconnect');
  }

  /** Supported events include create/change/delete and rename with oldPath. */
  handleEvent(event) {
    if (!this.running || !this.online || !event || typeof event !== 'object') return false;
    if (event.type === 'overflow') {
      void this.rescan('overflow').catch(() => {});
      return true;
    }
    let accepted = false;
    for (const candidate of [event.oldPath, event.path]) {
      const relative = this._normalize(candidate);
      if (relative === null) continue;
      this._pending.add(relative);
      accepted = true;
    }
    if (accepted && this._timer === null) {
      this._timer = setTimeout(() => {
        this._timer = null;
        void this._drainPending().catch(() => {});
      }, this.debounceMs);
      this._timer.unref?.();
    }
    return accepted;
  }

  /** Share queued scans; a running scan may have only one pending catch-up. */
  rescan(reason = 'manual') {
    if (!this.running || !this.online) return Promise.resolve(false);
    const force = ['startup', 'reconnect', 'manual', 'overflow', 'retry'].includes(reason);
    if (this._scan) {
      if (!this._scan.started) {
        this._scan.force ||= force;
        return this._scan.promise;
      }
      this._scanAgain ||= this._scanTicket(reason, force);
      this._scanAgain.force ||= force;
      return this._scanAgain.promise;
    }
    const ticket = this._scanTicket(reason, force);
    this._queueScan(ticket);
    return ticket.promise;
  }

  _scanTicket(reason, force) {
    const ticket = { epoch: this._epoch, reason, force, started: false };
    ticket.promise = new Promise((resolve, reject) => {
      ticket.resolve = resolve;
      ticket.reject = reject;
    });
    return ticket;
  }

  _queueScan(ticket) {
    this._scan = ticket;
    const queued = this._enqueue(() => {
      ticket.started = true;
      return this._fullScan(ticket.epoch, ticket.reason, ticket.force);
    }, ticket.epoch, ticket.reason);
    // Schedule catch-up after the running scan, never ahead of accumulated
    // real events. A slow NAS therefore cannot build an unbounded scan queue.
    queued.then((result) => this._finishScan(ticket, null, result),
      (error) => this._finishScan(ticket, error));
  }

  _finishScan(ticket, error, result) {
    if (this._scan === ticket) {
      this._scan = null;
      const next = this._scanAgain;
      this._scanAgain = null;
      if (next && this._active(next.epoch)) {
        void this._drainPending().catch(() => {});
        this._queueScan(next);
      } else if (next) {
        next.resolve(false);
      }
    }
    if (error) ticket.reject(error);
    else ticket.resolve(result);
  }

  async _fullScan(epoch, reason, force = false) {
    this._status({ state: 'scanning', reason });
    const snapshot = await this._snapshot(null, epoch);
    if (!snapshot || !this._active(epoch)) return false;
    // Recheck availability after the entire walk, before considering removals.
    await this._assertRoot();
    if (!this._active(epoch)) return false;
    const loaded = this._loadedPaths();
    await this._applySnapshot(snapshot, loaded, epoch, force);
    if (!this._active(epoch)) return false;
    for (const observed of this._observed.keys()) {
      if (!snapshot.has(observed)) this._observed.delete(observed);
    }
    this._status({ state: 'watching', reason });
    return true;
  }

  /** Flush debounce work and wait until this epoch's serialized queue settles. */
  async flush() {
    for (;;) {
      const queued = this._drainPending();
      await queued;
      if (!this._pending.size && queued === this._lastQueued) return;
    }
  }

  _invalidate() {
    this._epoch += 1;
    this._pending.clear();
    this._clearTimer();
    this._scanAgain?.resolve(false);
    this._scanAgain = null;
    this._scan = null;
    // Reconnect must recover missed events even when filesystem timestamps
    // were preserved. The cache is only a best-effort periodic-scan shortcut.
    this._observed.clear();
  }

  _clearTimer() {
    if (this._timer !== null) clearTimeout(this._timer);
    this._timer = null;
  }

  _active(epoch) {
    return this.running && this.online && this._epoch === epoch;
  }

  _status(status) {
    // Observers must not be able to break the file-event queue. No paths or file
    // contents are included in diagnostics; code alone is enough for the UI.
    try { this.onStatus(status); } catch (_) { /* observer failure */ }
  }

  _normalize(value) {
    const relative = normalizeRelativePath(value);
    if (relative === null || defaultIgnorePath(relative) || this.ignorePath(relative)) return null;
    return relative;
  }

  _absolute(relative) {
    const target = path.resolve(this.root, ...relative.split('/'));
    const check = path.relative(this.root, target);
    if (!check || check === '..' || check.startsWith(`..${path.sep}`) || path.isAbsolute(check)) {
      const error = new Error('Path is outside the vault.');
      error.code = 'INVALID_PATH';
      throw error;
    }
    return target;
  }

  _loadedPaths() {
    const loaded = this.getLoadedPaths();
    if (!loaded || typeof loaded[Symbol.iterator] !== 'function') {
      throw new TypeError('getLoadedPaths must return an iterable of relative paths.');
    }
    const paths = new Set();
    for (const candidate of loaded) {
      const relative = this._normalize(candidate);
      if (relative !== null) paths.add(relative);
    }
    return paths;
  }

  _enqueue(operation, epoch, reason) {
    const queued = this._tail.then(async () => {
      if (!this._active(epoch)) return false;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await operation();
        } catch (error) {
          if (!this._active(epoch)) return false;
          if (error.code === 'SCAN_CHANGED' && attempt === 0) {
            // A directory rename during enumeration invalidates the snapshot.
            // One delayed complete retry recovers it without a polling loop.
            await new Promise((resolve) => setTimeout(resolve, 100));
            if (!this._active(epoch)) return false;
            operation = () => this._fullScan(epoch, 'retry', true);
            continue;
          }
          this._status({ state: 'error', reason, code: error.code || 'RECONCILE_FAILED' });
          throw error;
        }
      }
    });
    this._lastQueued = queued;
    // Keep the queue usable after a failure, without swallowing the promise
    // returned to the explicit caller of rescan/flush.
    this._tail = queued.catch(() => false);
    return queued;
  }

  _drainPending() {
    this._clearTimer();
    if (!this.running || !this.online || !this._pending.size) return this._lastQueued;
    const epoch = this._epoch;
    const paths = [...this._pending];
    this._pending.clear();
    return this._enqueue(() => this._reconcileEvents(paths, epoch), epoch, 'events');
  }

  async _assertRoot() {
    // A cached ENOENT for a child must never be interpreted as deletion when
    // the share root itself cannot be enumerated.
    await this.fs.readdir(this.root, { withFileTypes: true });
  }

  async _pathInfo(relative) {
    const segments = relative.split('/');
    let stat;
    // lstat each ancestor: a junction or symlink must not escape this vault.
    for (let count = 1; count <= segments.length; count += 1) {
      try {
        stat = await this.fs.lstat(this._absolute(segments.slice(0, count).join('/')));
      } catch (error) {
        if (error.code === 'ENOENT') return { kind: 'missing' };
        throw error;
      }
      if (stat.isSymbolicLink()) return { kind: 'ignored' };
      if (count < segments.length && !stat.isDirectory()) return { kind: 'missing' };
    }
    const kind = stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'ignored';
    if (kind !== 'ignored') {
      const metadata = [stat.mtimeMs, stat.ctimeMs, stat.size];
      const signature = metadata.every(Number.isFinite) ? `${kind}:${metadata.join(':')}` : null;
      return { kind, signature };
    }
    return { kind: 'ignored' };
  }

  async _snapshot(scope, epoch) {
    const snapshot = new Map();
    if (scope !== null) {
      const info = await this._pathInfo(scope);
      if (!this._active(epoch)) return null;
      if (info.kind === 'ignored') return null;
      if (info.kind === 'missing') return snapshot;
      snapshot.set(scope, info.kind);
      if (info.kind !== 'directory') return snapshot;
    }
    const directories = [scope];
    while (directories.length) {
      if (!this._active(epoch)) return null;
      const directory = directories.pop();
      if (directory !== null) {
        const info = await this._pathInfo(directory);
        if (!this._active(epoch)) return null;
        if (info.kind !== 'directory') {
          const error = new Error('Directory changed during enumeration; retry the scan.');
          error.code = 'SCAN_CHANGED';
          throw error;
        }
      }
      let entries;
      try {
        entries = await this.fs.readdir(directory === null ? this.root : this._absolute(directory),
          { withFileTypes: true });
      } catch (error) {
        if (directory !== null && error.code === 'ENOENT') {
          const changed = new Error('Directory changed during enumeration; retry the scan.');
          changed.code = 'SCAN_CHANGED';
          throw changed;
        }
        throw error;
      }
      if (!this._active(epoch)) return null;
      for (const entry of entries) {
        const relative = this._normalize(directory === null ? entry.name : `${directory}/${entry.name}`);
        if (relative === null || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          snapshot.set(relative, 'directory');
          directories.push(relative);
        } else if (entry.isFile()) {
          snapshot.set(relative, 'file');
        }
      }
    }
    return snapshot;
  }

  async _applySnapshot(snapshot, loaded, epoch, force = false) {
    // Remove children before missing parents; create parents before children.
    const missing = [...loaded].filter((relative) => !snapshot.has(relative))
      .sort((a, b) => depth(b) - depth(a) || a.localeCompare(b));
    const present = [...snapshot.keys()].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b));
    for (const relative of missing) {
      if (!this._active(epoch)) return;
      // Guard each removal in case the connection failed during a long apply.
      await this._assertRoot();
      const info = await this._pathInfo(relative); // permission/network errors are not absence
      if (!this._active(epoch)) return;
      if (info.kind === 'ignored') continue;
      await this.applyPath(relative, { isCurrent: () => this._active(epoch) });
      if (this._active(epoch)) this._remember(relative, info);
    }
    for (const relative of present) {
      if (!this._active(epoch)) return;
      // Guard host adapters that incorrectly interpret any stat error as deletion.
      const info = await this._pathInfo(relative);
      if (!this._active(epoch)) return;
      if (info.kind === 'ignored') continue;
      if (info.kind === 'missing') await this._assertRoot();
      if (!this._active(epoch)) return;
      if (!force && loaded.has(relative) && info.signature !== null &&
        info.signature !== undefined && this._observed.get(relative) === info.signature) continue;
      await this.applyPath(relative, { isCurrent: () => this._active(epoch) });
      if (this._active(epoch)) this._remember(relative, info);
    }
  }

  _remember(relative, info) {
    if (info.kind === 'missing') {
      for (const observed of this._observed.keys()) {
        if (observed === relative || observed.startsWith(`${relative}/`)) this._observed.delete(observed);
      }
    } else if (info.signature !== null && info.signature !== undefined) {
      this._observed.set(relative, info.signature);
    } else {
      this._observed.delete(relative);
    }
  }

  async _reconcileEvents(paths, epoch) {
    await this._assertRoot();
    if (!this._active(epoch)) return false;
    // An ancestor event covers its whole subtree. Do not fold filename case.
    const scopes = paths.filter((relative) => !paths.some((other) =>
      other !== relative && relative.startsWith(`${other}/`)));
    // Read every affected subtree before applying any of this batch. A denied
    // or disconnected subtree cannot produce a partial deletion plan.
    const plans = [];
    for (const scope of scopes) {
      const snapshot = await this._snapshot(scope, epoch);
      if (!this._active(epoch)) return false;
      if (snapshot === null) continue;
      const loaded = new Set([...this._loadedPaths()].filter((relative) =>
        relative === scope || relative.startsWith(`${scope}/`)));
      // Deletion events should still reach the host if it did not expose the
      // old path in getLoadedPaths (for example an attachment cache entry).
      if (!snapshot.size) loaded.add(scope);
      plans.push({ snapshot, loaded });
    }
    await this._assertRoot();
    if (!this._active(epoch)) return false;
    for (const plan of plans) {
      // Events remain authoritative even when an external writer restores
      // timestamps or writes an equal-length replacement.
      await this._applySnapshot(plan.snapshot, plan.loaded, epoch, true);
      if (!this._active(epoch)) return false;
    }
    this._status({ state: 'watching', reason: 'events' });
    return true;
  }
}

module.exports = { Reconciler, normalizeRelativePath, defaultIgnorePath };
