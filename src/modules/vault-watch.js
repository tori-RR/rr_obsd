'use strict';
// Vault Watch — Windows 原生文件监听模块（自 obsidian-vault-watch v0.1.0 移植）。
// 外部行为与独立插件保持一致：状态机、事件流、设置项名称均未改动。
const { Notice, Setting, normalizePath } = require('obsidian');
const path = require('node:path');
const { NativeBridge } = require('../../lib/native-bridge');
const { Reconciler } = require('../../lib/reconciler');
const { createApplyPath } = require('../../lib/obsidian-adapter');

const DEFAULTS = { enabled: true, showStatus: true, debounceMs: 200 };
const LABELS = { stopped: '已暂停', starting: '启动中', scanning: '核对中', watching: '监听中',
  online: '监听中', idle: '监听中', offline: '等待连接', error: '需要检查', unsupported: '仅支持 Windows' };

class VaultWatchModule {
  constructor(host, settings, persist) {
    this.host = host;
    this.settings = settings;
    this.persist = persist;
    this.unloaded = false;
  }

  async onload() {
    this.settings.debounceMs = Math.max(100, Math.min(1000, Number(this.settings.debounceMs) || DEFAULTS.debounceMs));
    this.status = 'stopped';
    this.lifecycle = 0;
    this.changeCount = 0;
    this.statusEl = this.host.addStatusBarItem();
    this.statusEl.title = 'Vault Watch：Windows 原生文件通知';
    this.host.addCommand({ id: 'reconcile-now', name: '核对外部文件变化', callback: () => {
      if (!this.reconciler) return void new Notice('请先启用 Vault Watch 原生监听。');
      this.reconciler.rescan('manual').then(done => new Notice(done ? 'Vault Watch：核对完成。' : 'Vault Watch：当前未连接，稍后再试。')).catch(() => this.fail());
    }});
    this.host.addCommand({ id: 'restart-watcher', name: '重启原生监听', callback: () => void this.restart() });
    this.host.addCommand({ id: 'toggle-watcher', name: '启用／暂停原生监听', callback: async () => {
      this.settings.enabled = !this.settings.enabled;
      await this.persist();
      await this.restart();
    }});
    this.host.app.workspace.onLayoutReady(() => { if (!this.unloaded) void this.restart(); });
    this.renderStatus();
  }

  async restart() {
    const lifecycle = ++this.lifecycle;
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
    let engineStarted = false;
    const engine = new Reconciler({ root, debounceMs: this.settings.debounceMs,
      getLoadedPaths: () => this.host.app.vault.getAllLoadedFiles().map(file => file.path).filter(p => p && p !== '/'),
      applyPath: createApplyPath(adapter, normalizePath, isCurrent, () => this.changeCount++),
      onStatus: info => {
        if (isCurrent()) this.setStatus(info.state, info.code || info.errorCode || '');
      }
    });
    const bridge = new NativeBridge({ root, helperPath });
    this.reconciler = engine;
    this.bridge = bridge;
    this.setStatus('starting');
    const run = promise => Promise.resolve(promise).catch(() => { if (isCurrent()) this.fail(); });
    bridge.on('message', message => {
      if (!isCurrent()) return;
      switch (message.type) {
        case 'ready':
          if (!engineStarted) { engineStarted = true; run(engine.start()); }
          else run(engine.setOnline(true));
          break;
        case 'change':
          engine.handleEvent({ type: message.kind, path: message.path, oldPath: message.oldPath });
          break;
        case 'offline':
          engine.setOnline(false);
          this.setStatus('offline');
          break;
        case 'rescan':
          run(message.reason === 'reconnected' ? engine.setOnline(true) : engine.rescan(message.reason));
          break;
        case 'error':
          engine.setOnline(false);
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
    this.reconciler?.stop();
    void this.bridge?.stop();
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
    containerEl.createEl('p', { text: '首次启动、断线恢复或通知溢出时核对文件列表。正常运行依靠文件事件，不定时扫描全库。' });
  }
}

module.exports = { VaultWatchModule, VAULT_WATCH_DEFAULTS: DEFAULTS, VAULT_WATCH_LABELS: LABELS };
