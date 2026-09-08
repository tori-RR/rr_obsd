'use strict';

// A view refresh is a read followed by a guarded host load, never editor.setValue.
// Keeping this separate from the index queue makes the cancellation boundary explicit.
class EditorRefresh {
  constructor({ app, isCurrent = () => true, normalizePath = value => value,
    onConflict = () => {}, onError = () => {}, delayMs = 300 }) {
    Object.assign(this, { app, isCurrent, normalizePath, onConflict, onError, delayMs });
    this.online = false;
    this.stopped = false;
    this.epoch = 0;
    this.jobs = new Map();
    this.edits = new WeakMap();
  }

  _active(epoch = this.epoch) {
    return !this.stopped && this.online && this.epoch === epoch && this.isCurrent();
  }

  setOnline(online) {
    if (this.stopped || this.online === Boolean(online)) return;
    this.online = Boolean(online);
    this._invalidate();
  }

  _invalidate() {
    ++this.epoch;
    for (const job of this.jobs.values()) clearTimeout(job.timer);
    this.jobs.clear();
  }

  stop() {
    this.stopped = true;
    this.online = false;
    this._invalidate();
  }

  markEdited(editor) {
    if (editor && typeof editor === 'object') this.edits.set(editor, (this.edits.get(editor) || 0) + 1);
  }

  _views(relative) {
    const leaves = this.app.workspace.getLeavesOfType?.('markdown') || [];
    return leaves.map(leaf => leaf.view).filter(view => view?.getViewType?.() === 'markdown' &&
      view.getMode?.() === 'source' && view.file?.path === relative && !view.file.deleted && view.editor);
  }

  _path(relative) {
    if (typeof relative !== 'string' || !relative || /^[\\/]|^[a-z]:/i.test(relative)) return null;
    const value = this.normalizePath(relative.replace(/\\/g, '/'));
    if (!value || value.split('/').some(part => part.startsWith('.') || part.includes(':'))) return null;
    return value;
  }

  _job(relative) {
    const key = this._path(relative);
    if (!this._active() || !key || !this._views(key).length) return null;
    let job = this.jobs.get(key);
    if (!job) {
      job = { path: key, epoch: this.epoch, version: 0, running: false, again: false, timer: null };
      this.jobs.set(key, job);
    }
    ++job.version;
    clearTimeout(job.timer);
    job.timer = null;
    if (job.running) job.again = true;
    return job;
  }

  request(relative) {
    const job = this._job(relative);
    if (!job || job.running) return;
    job.timer = setTimeout(() => {
      job.timer = null;
      void this._run(job);
    }, this.delayMs);
    job.timer.unref?.();
  }

  refreshNow(relative) {
    const job = this._job(relative);
    if (!job) return Promise.resolve(false);
    return job.running ? job.promise : this._run(job);
  }

  refreshOpen() {
    const paths = new Set((this.app.workspace.getLeavesOfType?.('markdown') || [])
      .map(leaf => leaf.view?.file?.path).filter(Boolean));
    return Promise.all([...paths].map(relative => this.refreshNow(relative)));
  }

  refreshActive() {
    const relative = this.app.workspace.getMostRecentLeaf?.()?.view?.file?.path;
    return relative ? this.refreshNow(relative) : Promise.resolve(false);
  }

  _run(job) {
    job.running = true;
    job.promise = (async () => {
      let applied = false;
      try {
        do {
          job.again = false;
          const version = job.version;
          applied = await this._refresh(job.path, () => this._active(job.epoch) &&
            this.jobs.get(job.path) === job && job.version === version) || applied;
        } while (job.again && this._active(job.epoch) && this.jobs.get(job.path) === job);
      } catch (error) {
        if (this._active(job.epoch)) this.onError({ code: error.code || 'EDITOR_REFRESH_FAILED' });
      } finally {
        job.running = false;
        if (this.jobs.get(job.path) === job) this.jobs.delete(job.path);
      }
      return applied;
    })();
    return job.promise;
  }

  async _refresh(relative, current) {
    if (!current()) return false;
    const file = this.app.vault.getAbstractFileByPath(relative);
    if (!file || file.children || file.deleted) return false;
    const snapshots = this._views(relative).filter(view => view.file === file && typeof view.setData === 'function')
      .map(view => ({ view, editor: view.editor, baseline: view.lastSavedData,
        text: view.editor.getValue(), dirty: !!view.dirty, saving: !!view.saving, composing: !!view.editor.cm?.composing,
        edit: this.edits.get(view.editor) || 0, doc: view.editor.cm?.state?.doc }));
    if (!snapshots.length) return false;
    const fresh = await this.app.vault.read(file);
    if (!current() || file.deleted || file.path !== relative ||
      this.app.vault.getAbstractFileByPath(relative) !== file) return false;
    const currentViews = new Set(this._views(relative));
    const valid = snapshots.filter(s => currentViews.has(s.view) && s.view.file === file && s.view.editor === s.editor);
    if (!valid.length || currentViews.size !== snapshots.length || valid.length !== snapshots.length) return false;
    // One dirty view of a shared document is enough to defer the whole document.
    const conflicted = valid.some(s => s.dirty || s.saving || s.composing || s.editor.cm?.composing || s.view.dirty || s.view.saving ||
      typeof s.baseline !== 'string' || s.text !== s.baseline || s.view.lastSavedData !== s.baseline ||
      s.editor.getValue() !== s.text || (this.edits.get(s.editor) || 0) !== s.edit ||
      (s.doc && s.editor.cm?.state?.doc !== s.doc));
    if (conflicted) {
      if (valid.some(s => typeof s.baseline === 'string' && fresh !== s.baseline && fresh !== s.editor.getValue())) {
        this.onConflict({ path: relative, code: 'LOCAL_EDITS_PRESERVED' });
      }
      return false;
    }
    let applied = false;
    for (const s of valid) {
      if (!current() || s.view.file !== file || s.view.editor !== s.editor) return applied;
      if (s.editor.getValue() === fresh) continue;
      // A host event from updating another split can synchronously edit this one.
      if (s.view.dirty || s.view.saving || s.editor.cm?.composing || s.view.lastSavedData !== s.baseline ||
        s.editor.getValue() !== s.text || (this.edits.get(s.editor) || 0) !== s.edit ||
        (s.doc && s.editor.cm?.state?.doc !== s.doc)) return applied;
      const selections = s.editor.listSelections?.();
      const scroll = s.editor.getScrollInfo?.();
      const previousBaseline = s.view.lastSavedData;
      // Match the host's clean external-load baseline; its mode setter uses a
      // host "set" transaction, avoiding a user edit/autosave feedback loop.
      s.view.lastSavedData = fresh;
      try {
        s.view.setData(fresh, false);
        if (!current() || s.view.file !== file || s.view.editor !== s.editor) return true;
        if (s.editor.getValue() !== fresh && typeof s.view.setViewData === 'function') s.view.setViewData(fresh, false);
      } catch (error) {
        s.view.lastSavedData = previousBaseline;
        throw error;
      }
      applied = true;
      if (!current() || s.view.file !== file || s.view.editor !== s.editor) return applied;
      if (selections?.length && s.editor.setSelections) {
        const lines = fresh.split(/\r?\n/);
        const clamp = position => {
          const line = Math.max(0, Math.min(lines.length - 1, position.line));
          return { line, ch: Math.max(0, Math.min(lines[line].length, position.ch)) };
        };
        try { s.editor.setSelections(selections.map(range => ({ anchor: clamp(range.anchor), head: clamp(range.head) }))); }
        catch { /* Host selections may have changed synchronously; retain the host's valid result. */ }
      }
      if (scroll && s.editor.scrollTo) s.editor.scrollTo(scroll.left, scroll.top);
    }
    return applied;
  }
}

module.exports = { EditorRefresh };
