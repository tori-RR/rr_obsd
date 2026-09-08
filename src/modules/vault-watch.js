'use strict';
// Vault Watch — Windows 原生文件监听模块（自 obsidian-vault-watch v0.1.0 移植）。
// The index pipeline and clean-editor loading have separate cancellation guards.
const { Notice, Setting, normalizePath } = require('obsidian');
const path = require('node:path');
const { NativeBridge } = require('../vault-watch/native-bridge');
const { Reconciler } = require('../vault-watch/reconciler');
const { createApplyPath } = require('../vault-watch/obsidian-adapter');
const { EditorRefresh } = require('../vault-watch/editor-refresh');

const DEFAULTS = { enabled: true, showStatus: true, debounceMs: 200, activeCheckSeconds: 5, safetyScanSeconds: 180 };
const LABELS = { stopped: '已暂停', starting: '启动中', scanning: '核对中', watching: '监听中',
  online: '监听中', idle: '监听中', offline: '等待连接', error: '需要检查', unsupported: '仅支持 Windows' };

class VaultWatchModule {
  constructor(host, settings, persist) {
    this.host = host;
    this.settings = settings;
    this.persist = persist;
    this.unloaded = false;
    this._activeTimer = null;
    this._safetyTimer = null;
    this.timerEpoch = 0;
    this.online = false;
  }

  async onload() {
    this.settings.debounceMs = Math.max(100, Math.min(1000, Number(this.settings.debounceMs) || DEFAULTS.debounceMs));
    this.settings.activeCheckSeconds = Math.max(0, Math.min(30, Number(this.settings.activeCheckSeconds ?? DEFAULTS.activeCheckSeconds) || 0));
    this.settings.safetyScanSeconds = Math.max(0, Math.min(600, Number(this.settings.safetyScanSeconds ?? DEFAULTS.safetyScanSeconds) || 0));
    if (this.settings.safetyScanSeconds > 0) this.settings.safetyScanSeconds = Math.max(30, this.settings.safetyScanSeconds);
    this.status = 'stopped';
    this.lifecycle = 0;
    this.changeCount = 0;
    this.statusEl = this.host.addStatusBarItem();
    this.statusEl.title = 'Vault Watch：Windows 原生文件通知';
    this.host.addCommand({ id: 'reconcile-now', name: '核对外部文件变化', callback: () => {
      if (!this.reconciler) return void new Notice('请先启用 Vault Watch 原生监听。');
      this.reconciler.rescan('manual').then(async done => {
        if (done) await this.editorRefresh?.refreshOpen();
        new Notice(done ? 'Vault Watch：核对完成；有本地编辑的笔记会保留输入。' : 'Vault Watch：当前未连接，稍后再试。');
      }).catch(() => this.fail());
    }});
    this.host.addCommand({ id: 'restart-watcher', name: '重启原生监听', callback: () => void this.restart() });
    this.host.addCommand({ id: 'toggle-watcher', name: '启用／暂停原生监听', callback: async () => {
      this.settings.enabled = !this.settings.enabled;
      await this.persist();
      await this.restart();
    }});
    this.host.app.workspace.onLayoutReady(() => { if (!this.unloaded) void this.restart(); });
    if (typeof this.host.app.workspace.on === 'function' && typeof this.host.registerEvent === 'function') {
      this.host.registerEvent(this.host.app.workspace.on('editor-change', editor => this.editorRefresh?.markEdited(editor)));
      this.host.registerEvent(this.host.app.workspace.on('file-open', () => { void this.editorRefresh?.refreshActive(); }));
      this.host.registerEvent(this.host.app.workspace.on('active-leaf-change', () => { void this.editorRefresh?.refreshActive(); }));
    }
    this.renderStatus();
  }

  async restart() {
    const lifecycle = ++this.lifecycle;
    this.online = false;
    this.stopTimers();
    this.editorRefresh?.stop();
    this.editorRefresh = null;
    this.reconciler?.stop();
    this.reconciler = null;
    const previous = this.bridge;
    this.bridge = null;
    if (previous) await previous.stop();
    if (lifecycle !== this.lifecycle || this.unloaded) return;
    if (!this.settings.enabled) return this.setStatus('stopped');
    if (process.platform !== 'win32') return this.setStatus('unsupported');
    const adapter = this.host.app.vault.adapter;
    if (!['getBasePath', 'queue', 'reconcileFile'].every(key => typeof adapter?.[key] === 'function')) {
      return this.fail('当前 Obsidian 版本的刷新接口不兼容，原生监听未启用。');
    }
    const root = adapter.getBasePath();
    const helperPath = path.join(root, this.host.manifest.dir || normalizePath(`${this.host.app.vault.configDir}/plugins/${this.host.manifest.id}`), 'native', 'watch.ps1');
    const isCurrent = () => !this.unloaded && lifecycle === this.lifecycle;
    const refresh = new EditorRefresh({ app: this.host.app, isCurrent, normalizePath,
      onConflict: () => {
        const now = Date.now();
        if (!this.lastConflictAt || now - this.lastConflictAt > 30000) {
          this.lastConflictAt = now;
          new Notice('Vault Watch：检测到本地编辑与磁盘内容不同，已保留你的输入。');
        }
      },
      onError: info => { if (isCurrent()) this.lastErrorCode = info.code; }
    });
    this.editorRefresh = refresh;
    let engineStarted = false;
    const engine = new Reconciler({ root, debounceMs: this.settings.debounceMs,
      getLoadedPaths: () => this.host.app.vault.getAllLoadedFiles().map(file => file.path).filter(p => p && p !== '/'),
      applyPath: createApplyPath(adapter, normalizePath, isCurrent, relative => { this.changeCount++; refresh.request(relative); }),
      onStatus: info => {
        if (isCurrent()) this.setStatus(info.state, info.code || info.errorCode || '');
      }
    });
    const bridge = new NativeBridge({ root, helperPath });
    this.reconciler = engine;
    this.bridge = bridge;
    this.setStatus('starting');
    const run = promise => Promise.resolve(promise).catch(() => { if (isCurrent()) this.fail(); });
    const afterScan = promise => {
      const timerEpoch = this.timerEpoch;
      return run(Promise.resolve(promise).then(async done => {
        if (!isCurrent() || timerEpoch !== this.timerEpoch) return;
        if (done) await refresh.refreshOpen();
      }).finally(() => {
        if (isCurrent() && this.online && timerEpoch === this.timerEpoch) this.startTimers(lifecycle);
      }));
    };
    bridge.on('message', message => {
      if (!isCurrent()) return;
      switch (message.type) {
        case 'ready':
          this.online = true;
          refresh.setOnline(true);
          if (!engineStarted) { engineStarted = true; afterScan(engine.start()); }
          else afterScan(engine.setOnline(true));
          break;
        case 'change':
          engine.handleEvent({ type: message.kind, path: message.path, oldPath: message.oldPath });
          if (message.kind === 'update') refresh.request(message.path);
          break;
        case 'offline':
          engine.setOnline(false);
          this.online = false;
          refresh.setOnline(false);
          this.stopTimers();
          this.setStatus('offline');
          break;
        case 'rescan':
          if (message.reason === 'reconnected') {
            this.online = true;
            refresh.setOnline(true);
            afterScan(engine.setOnline(true));
          } else afterScan(engine.rescan(message.reason));
          break;
        case 'error':
          engine.setOnline(false);
          this.online = false;
          refresh.setOnline(false);
          this.stopTimers();
          this.fail('原生监听启动失败，请查看设置页并重启监听。');
          break;
      }
    });
    bridge.on('diagnostic', detail => { if (isCurrent()) this.lastErrorCode = detail.code; });
    try { await bridge.start(); } catch { if (isCurrent()) this.fail(); }
  }

  setStatus(state, code = '') {
    this.status = state;
    if (code) this.lastErrorCode = code;
    this.renderStatus();
  }

  renderStatus() {
    if (!this.statusEl) return;
    this.statusEl.textContent = `Vault Watch · ${LABELS[this.status] || this.status}`;
    this.statusEl.style.display = this.settings.showStatus ? '' : 'none';
  }

  fail(message = 'Vault Watch 暂停刷新，请检查连接并重启监听。') {
    this.setStatus('error');
    const now = Date.now();
    if (!this.lastNoticeAt || now - this.lastNoticeAt > 30000) { this.lastNoticeAt = now; new Notice(message); }
  }

  onunload() {
    this.unloaded = true;
    ++this.lifecycle;
    this.online = false;
    this.stopTimers();
    this.editorRefresh?.stop();
    this.reconciler?.stop();
    void this.bridge?.stop();
  }

  stopTimers() {
    ++this.timerEpoch;
    clearTimeout(this._activeTimer);
    clearTimeout(this._safetyTimer);
    this._activeTimer = this._safetyTimer = null;
  }

  startTimers(lifecycle) {
    const timerEpoch = this.timerEpoch;
    const current = () => !this.unloaded && this.online && this.settings.enabled && lifecycle === this.lifecycle && timerEpoch === this.timerEpoch;
    if (!current()) return;
    const arm = (key, seconds, operation) => {
      if (!seconds || this[key] !== null) return;
      // Keep a timer slot occupied until the async operation finishes, so no
      // second scan/read is scheduled while a slow NAS call is in flight.
      const timer = setTimeout(async () => {
        if (!current()) return;
        try { await operation(); } catch { if (current()) this.fail(); }
        finally {
          if (current() && this[key] === timer) { this[key] = null; this.startTimers(lifecycle); }
        }
      }, seconds * 1000);
      this[key] = timer;
      this[key].unref?.();
    };
    arm('_activeTimer', this.settings.activeCheckSeconds, () => this.editorRefresh?.refreshActive());
    arm('_safetyTimer', this.settings.safetyScanSeconds, async () => {
      const done = await this.reconciler?.rescan('safety');
      if (done && current()) await this.editorRefresh?.refreshOpen();
    });
  }

  renderSettings(containerEl, rerender = () => { containerEl.empty(); this.renderSettings(containerEl); }) {
    containerEl.createEl('p', { text: '让外部编辑自动反映到当前仓库。笔记仍保存在原位置。' });
    new Setting(containerEl).setName('原生文件监听').setDesc('设置立即生效。每个已打开的仓库运行一个隐藏的 Windows 监听进程。')
      .addToggle(toggle => toggle.setValue(this.settings.enabled).onChange(async value => {
        this.settings.enabled = value; await this.persist(); await this.restart(); rerender();
      }));
    new Setting(containerEl).setName('状态栏').addToggle(toggle => toggle.setValue(this.settings.showStatus).onChange(async value => {
      this.settings.showStatus = value; await this.persist(); this.renderStatus();
    }));
    new Setting(containerEl).setName('合并变化的等待时间').setDesc('批量修改时合并重复事件，单位为毫秒。')
      .addSlider(slider => slider.setLimits(100, 1000, 50).setValue(this.settings.debounceMs).setDynamicTooltip().onChange(async value => {
        this.settings.debounceMs = value; await this.persist(); await this.restart();
      }));
    new Setting(containerEl).setName('当前状态').setDesc(`${LABELS[this.status] || this.status}${this.lastErrorCode ? ` · ${this.lastErrorCode}` : ''}`)
      .addButton(button => button.setButtonText('重启监听').onClick(async () => { await this.restart(); rerender(); }));
    new Setting(containerEl).setName('活动笔记补查').setDesc('秒；只检查当前打开的编辑笔记，0 为关闭。正在编辑时保留本地输入。')
      .addSlider(slider => slider.setLimits(0, 30, 1).setValue(this.settings.activeCheckSeconds).setDynamicTooltip().onChange(async value => {
        this.settings.activeCheckSeconds = value; await this.persist(); await this.restart();
      }));
    new Setting(containerEl).setName('全库兜底检查').setDesc('秒；完成一轮后再等待，0 为关闭。未变化的文件不重复更新索引。')
      .addSlider(slider => slider.setLimits(0, 600, 30).setValue(this.settings.safetyScanSeconds).setDynamicTooltip().onChange(async value => {
        this.settings.safetyScanSeconds = value; await this.persist(); await this.restart();
      }));
    containerEl.createEl('p', { text: '正常按事件更新；漏通知时补查活动笔记并低频核对目录。启动、恢复和手动检查执行完整核对。' });
  }
}

module.exports = { VaultWatchModule, VAULT_WATCH_DEFAULTS: DEFAULTS, VAULT_WATCH_LABELS: LABELS };
