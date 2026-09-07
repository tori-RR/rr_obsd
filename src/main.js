'use strict';
// RR Obsd Toolbox — 主入口：三个功能模块的宿主与统一设置面板。
// 模块：表格行号（trn）/ 悬浮新建笔记（fnn）/ Vault Watch 原生监听（vw）。
const { Plugin, PluginSettingTab, normalizePath } = require('obsidian');
const { VaultWatchModule } = require('./modules/vault-watch');
const { TableRowNumberModule } = require('./modules/table-row-number');
const { FloatingNewNoteModule } = require('./modules/floating-new-note');

const DEFAULTS = {
  trn: {
    enabled: true,
    startFrom: 1,
    format: "decimal",
    separator: ". ",
    fontFamilyPreset: "inherit",
    customFontFamily: "",
    fontSize: "1em",
    fontWeight: "600"
  },
  fnn: {
    enabled: true,
    icon: "pen-box",
    targetFolder: "New",
    zoneSize: 120,
    fabSize: 56,
    fabOffsetX: 24,
    fabOffsetY: 24,
    opacity: 0,
    hoverBlend: 0.4,
    btnOpacity: 1,
    debugHoverScale: 1.12,
    debugActiveScale: 0.9
  },
  vw: { enabled: true, showStatus: true, debounceMs: 200 }
};

module.exports = class RRObsdToolbox extends Plugin {
  async onload() {
    const stored = await this.loadData();
    this.settings = {
      trn: { ...DEFAULTS.trn, ...stored?.trn },
      fnn: { ...DEFAULTS.fnn, ...stored?.fnn },
      vw: { ...DEFAULTS.vw, ...stored?.vw }
    };
    await this.migrateLegacySettings(stored == null);

    const persist = () => this.saveData(this.settings);
    this.trn = new TableRowNumberModule(this, this.settings.trn, persist);
    this.fnn = new FloatingNewNoteModule(this, this.settings.fnn, persist);
    this.vw = new VaultWatchModule(this, this.settings.vw, persist);

    this.addSettingTab(new RRObsdSettingTab(this.app, this));
    await this.trn.onload();
    await this.fnn.onload();
    await this.vw.onload();
  }

  // 一次性迁移：首次安装时读取旧独立插件（table-row-number / floating-new-note）的 data.json。
  async migrateLegacySettings(freshInstall) {
    if (!freshInstall) return;
    try {
      const adapter = this.app.vault.adapter;
      if (typeof adapter?.read !== 'function') return;
      const configDir = this.app.vault.configDir;
      const readJson = async (id) => {
        try { return JSON.parse(await adapter.read(normalizePath(`${configDir}/plugins/${id}/data.json`))); }
        catch { return null; }
      };
      let migrated = false;
      const trn = await readJson('table-row-number');
      if (trn) { this.settings.trn = { ...this.settings.trn, ...trn }; migrated = true; }
      const fnn = await readJson('floating-new-note');
      if (fnn) { this.settings.fnn = { ...this.settings.fnn, ...fnn }; migrated = true; }
      if (migrated) await this.saveData(this.settings);
    } catch (error) {
      console.warn('[RR Obsd] legacy settings migration skipped:', error);
    }
  }

  onunload() {
    this.trn?.onunload();
    this.fnn?.onunload();
    this.vw?.onunload();
  }
};

class RRObsdSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl, plugin } = this;
    const rerender = () => this.display();
    containerEl.empty();

    containerEl.createEl('h2', { text: '表格行号 · Table Row Number' });
    plugin.trn.renderSettings(containerEl, rerender);

    containerEl.createEl('hr');
    containerEl.createEl('h2', { text: '悬浮新建笔记 · Floating New Note' });
    plugin.fnn.renderSettings(containerEl, rerender);

    containerEl.createEl('hr');
    containerEl.createEl('h2', { text: 'NAS 原生监听 · Vault Watch' });
    plugin.vw.renderSettings(containerEl, rerender);
  }
}
