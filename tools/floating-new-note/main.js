"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// main.ts
var main_exports = {};
__export(main_exports, {
  default: () => FloatingNewNotePlugin
});
module.exports = __toCommonJS(main_exports);
var import_obsidian = require("obsidian");
var DEFAULT_SETTINGS = {
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
};
var FloatingNewNotePlugin = class extends import_obsidian.Plugin {
  constructor() {
    super(...arguments);
    this.settings = DEFAULT_SETTINGS;
  }
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new FloatingNewNoteSettingTab(this.app, this));
    this.registerEvent(
      this.app.workspace.on("layout-change", () => this.injectAll())
    );
    this.registerEvent(
      this.app.workspace.on("resize", () => this.injectAll())
    );
    this.app.workspace.onLayoutReady(() => this.injectAll());
  }
  injectAll() {
    if (!this.settings.enabled) {
      this.removeAll();
      return;
    }
    const leaves = this.app.workspace.getLeavesOfType("markdown");
    for (const leaf of leaves) {
      const container = leaf.containerEl;
      if (!container) continue;
      if (container.querySelector(".fab-container")) {
        this.updateStyles(container);
        continue;
      }
      this.inject(container);
    }
  }
  inject(container) {
    const fab = container.createDiv({ cls: "fab-container" });
    const btn = fab.createDiv({ cls: "fab-btn" });
    (0, import_obsidian.setIcon)(btn, this.settings.icon);
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const app = this.app;
      const folder = (this.settings.targetFolder || "").replace(/^\/+|\/+$/g, "");
      try {
        if (folder && !app.vault.getAbstractFileByPath(folder)) {
          await app.vault.createFolder(folder);
        }
        let name = "Untitled";
        let i = 0;
        const pathOf = (n) => folder ? `${folder}/${n}.md` : `${n}.md`;
        while (app.vault.getAbstractFileByPath(pathOf(name))) {
          i++;
          name = `Untitled ${i}`;
        }
        const file = await app.vault.create(pathOf(name), "");
        await app.workspace.getLeaf().openFile(file);
      } catch (err) {
        console.error("[FloatingNewNote] create failed:", err);
      }
    });
    this.updateStyles(container);
  }
  updateStyles(container) {
    const fab = container.querySelector(".fab-container");
    if (!fab) return;
    const { opacity, hoverBlend, btnOpacity } = this.settings;
    const hoverOpacity = opacity + (btnOpacity - opacity) * hoverBlend;
    const activeOpacity = Math.max(btnOpacity, opacity);
    fab.style.setProperty("--fab-zone", `${this.settings.zoneSize}px`);
    fab.style.setProperty("--fab-size", `${this.settings.fabSize}px`);
    fab.style.setProperty("--fab-offset-x", `${this.settings.fabOffsetX}px`);
    fab.style.setProperty("--fab-offset-y", `${this.settings.fabOffsetY}px`);
    fab.style.setProperty("--fab-opacity", `${opacity}`);
    fab.style.setProperty("--fab-hover-opacity", `${hoverOpacity}`);
    fab.style.setProperty("--fab-active-opacity", `${activeOpacity}`);
    fab.style.setProperty("--fab-hover-scale", `${this.settings.debugHoverScale}`);
    fab.style.setProperty("--fab-active-scale", `${this.settings.debugActiveScale}`);
    const btn = fab.querySelector(".fab-btn");
    if (btn && this.settings.icon) {
      (0, import_obsidian.setIcon)(btn, this.settings.icon);
    }
  }
  removeAll() {
    document.querySelectorAll(".fab-container").forEach((el) => el.remove());
  }
  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }
  async saveSettings() {
    await this.saveData(this.settings);
    this.injectAll();
  }
  onunload() {
    this.removeAll();
  }
};
var IconPicker = class {
  constructor(container, value, onChange) {
    this.allIcons = [];
    this.isOpen = false;
    this.container = container;
    this.value = value;
    this.onChange = onChange;
    try {
      this.allIcons = (0, import_obsidian.getIconIds)().sort();
    } catch {
      this.allIcons = [
        "pen-box",
        "file-plus",
        "pencil",
        "feather",
        "create",
        "edit",
        "edit-3",
        "file-text",
        "file-edit",
        "note",
        "notebook",
        "book",
        "book-open",
        "book-plus",
        "square-pen",
        "sticky-note",
        "plus",
        "plus-circle",
        "plus-square",
        "circle-plus",
        "file",
        "folder-plus",
        "square",
        "circle",
        "star",
        "heart",
        "bookmark",
        "tag",
        "flag"
      ].sort();
    }
    this.render();
  }
  render() {
    const wrapper = this.container.createDiv({ cls: "icon-picker-wrapper" });
    this.previewEl = wrapper.createDiv({ cls: "icon-picker-preview" });
    this.updatePreview();
    this.inputEl = wrapper.createEl("input", {
      cls: "icon-picker-input",
      type: "text",
      placeholder: "\u641C\u7D22\u56FE\u6807\u2026",
      value: this.value
    });
    this.dropdownEl = wrapper.createDiv({ cls: "icon-picker-dropdown" });
    this.dropdownEl.style.display = "none";
    this.inputEl.addEventListener("focus", () => this.open());
    this.inputEl.addEventListener("input", () => this.filter());
    this.inputEl.addEventListener("blur", () => {
      setTimeout(() => this.close(), 200);
    });
    document.addEventListener("click", (e) => {
      if (!wrapper.contains(e.target)) this.close();
    });
  }
  updatePreview() {
    this.previewEl.empty();
    try {
      (0, import_obsidian.setIcon)(this.previewEl, this.value);
    } catch {
      this.previewEl.setText("?");
    }
  }
  open() {
    this.isOpen = true;
    this.dropdownEl.style.display = "block";
    this.filter();
  }
  close() {
    this.isOpen = false;
    this.dropdownEl.style.display = "none";
  }
  filter() {
    const query = this.inputEl.value.toLowerCase().trim();
    const matched = query ? this.allIcons.filter((id) => id.includes(query)).slice(0, 80) : this.allIcons.slice(0, 80);
    this.dropdownEl.empty();
    if (matched.length === 0) {
      this.dropdownEl.createDiv({ cls: "icon-picker-empty" }).setText("\u65E0\u5339\u914D\u56FE\u6807");
      return;
    }
    for (const iconId of matched) {
      const row = this.dropdownEl.createDiv({ cls: "icon-picker-row" });
      const iconEl = row.createDiv({ cls: "icon-picker-row-icon" });
      try {
        (0, import_obsidian.setIcon)(iconEl, iconId);
      } catch {
      }
      row.createDiv({ cls: "icon-picker-row-name" }).setText(iconId);
      if (iconId === this.value) {
        row.addClass("is-selected");
      }
      row.addEventListener("click", () => {
        this.value = iconId;
        this.inputEl.value = iconId;
        this.updatePreview();
        this.onChange(iconId);
        this.close();
      });
    }
  }
};
var FloatingNewNoteSettingTab = class extends import_obsidian.PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new import_obsidian.Setting(containerEl).setName("\u542F\u7528\u60AC\u6D6E\u6309\u94AE").setDesc("\u5173\u95ED\u540E\u79FB\u9664\u6240\u6709\u5DF2\u6CE8\u5165\u7684\u6309\u94AE").addToggle(
      (toggle) => toggle.setValue(this.plugin.settings.enabled).onChange(async (value) => {
        this.plugin.settings.enabled = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u76EE\u6807\u6587\u4EF6\u5939").setDesc("\u65B0\u5EFA\u7B14\u8BB0\u4FDD\u5B58\u8DEF\u5F84\uFF08\u76F8\u5BF9 vault \u6839\uFF09\u3002\u9ED8\u8BA4 New\uFF1B\u7559\u7A7A\u5219\u5199\u5230\u6839\u76EE\u5F55").addText(
      (t) => t.setPlaceholder("New").setValue(this.plugin.settings.targetFolder ?? "New").onChange(async (value) => {
        this.plugin.settings.targetFolder = value.trim();
        await this.plugin.saveSettings();
      })
    );
    const iconSetting = new import_obsidian.Setting(containerEl).setName("\u56FE\u6807").setDesc("\u70B9\u51FB\u8F93\u5165\u6846\u641C\u7D22\uFF0C\u6216\u76F4\u63A5\u8F93\u5165 Lucide \u56FE\u6807\u540D\u79F0");
    const pickerHost = iconSetting.controlEl.createDiv({ cls: "icon-picker-host" });
    new IconPicker(pickerHost, this.plugin.settings.icon, async (value) => {
      this.plugin.settings.icon = value;
      await this.plugin.saveSettings();
    });
    new import_obsidian.Setting(containerEl).setName("\u70ED\u533A\u5927\u5C0F").setDesc("\u9F20\u6807\u9760\u8FD1\u591A\u5927\u7684\u8303\u56F4\u4F1A\u89E6\u53D1\u663E\u793A\uFF0880~240px\uFF09").addSlider(
      (slider) => slider.setLimits(80, 240, 4).setValue(this.plugin.settings.zoneSize).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.zoneSize = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u6309\u94AE\u5927\u5C0F").setDesc("\u5706\u5F62\u6309\u94AE\u7684\u76F4\u5F84\uFF0836~80px\uFF09").addSlider(
      (slider) => slider.setLimits(36, 80, 2).setValue(this.plugin.settings.fabSize).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.fabSize = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u6C34\u5E73\u504F\u79FB").setDesc("\u6309\u94AE\u79BB\u5DE6\u8FB9\u7F18\u7684\u8DDD\u79BB\uFF080~80px\uFF09").addSlider(
      (slider) => slider.setLimits(0, 80, 2).setValue(this.plugin.settings.fabOffsetX).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.fabOffsetX = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u5782\u76F4\u504F\u79FB").setDesc("\u6309\u94AE\u79BB\u5E95\u8FB9\u7F18\u7684\u8DDD\u79BB\uFF080~80px\uFF09").addSlider(
      (slider) => slider.setLimits(0, 80, 2).setValue(this.plugin.settings.fabOffsetY).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.fabOffsetY = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u9ED8\u8BA4\u900F\u660E\u5EA6").setDesc("\u70ED\u533A\u5916\u6309\u94AE\u7684\u900F\u660E\u5EA6\uFF080=\u5B8C\u5168\u9690\u85CF\uFF0C1=\u5B8C\u5168\u4E0D\u900F\u660E\uFF09").addSlider(
      (slider) => slider.setLimits(0, 1, 0.05).setValue(this.plugin.settings.opacity).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.opacity = value;
        await this.plugin.saveSettings();
        this.display();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u70ED\u533A\u60AC\u505C\u900F\u660E\u5EA6").setDesc("0=\u548C\u9ED8\u8BA4\u900F\u660E\u5EA6\u4E00\u81F4\uFF0C1=\u548C\u6309\u94AE\u60AC\u505C\u900F\u660E\u5EA6\u4E00\u81F4\uFF0C\u4E2D\u95F4\u503C\u4E3A\u4E24\u8005\u63D2\u503C").addSlider(
      (slider) => slider.setLimits(0, 1, 0.05).setValue(this.plugin.settings.hoverBlend).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.hoverBlend = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("\u6309\u94AE\u60AC\u505C\u900F\u660E\u5EA6").setDesc("\u9F20\u6807\u60AC\u505C\u5728\u6309\u94AE\u4E0A\u65F6\u7684\u900F\u660E\u5EA6\uFF08\u4F4E\u4E8E\u9ED8\u8BA4\u900F\u660E\u5EA6\u65F6\u81EA\u52A8\u53D6\u9ED8\u8BA4\u503C\uFF09").addSlider(
      (slider) => slider.setLimits(0, 1, 0.05).setValue(this.plugin.settings.btnOpacity).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.btnOpacity = value;
        await this.plugin.saveSettings();
        this.display();
      })
    );
    containerEl.createEl("hr");
    const debugHeader = containerEl.createDiv({ cls: "setting-item-description" });
    debugHeader.style.fontStyle = "italic";
    debugHeader.style.opacity = "0.6";
    debugHeader.setText("\u4EE5\u4E0B\u4E3A\u5F00\u53D1\u8005\u8C03\u8BD5\u53C2\u6570\uFF0C\u786E\u5B9A\u6548\u679C\u540E\u4F1A\u5220\u9664");
    new import_obsidian.Setting(containerEl).setName("[\u8C03\u8BD5] \u56DE\u5F39\u653E\u5927\u500D\u6570").setDesc("\u9F20\u6807\u60AC\u505C\u65F6\u6309\u94AE\u653E\u5927\u500D\u6570\uFF081.0=\u4E0D\u653E\u5927\uFF0C1.2=\u653E\u592720%\uFF09").addSlider(
      (slider) => slider.setLimits(1, 1.5, 0.01).setValue(this.plugin.settings.debugHoverScale).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.debugHoverScale = value;
        await this.plugin.saveSettings();
      })
    );
    new import_obsidian.Setting(containerEl).setName("[\u8C03\u8BD5] \u70B9\u51FB\u6536\u7F29\u500D\u6570").setDesc("\u70B9\u51FB\u6309\u94AE\u65F6\u6536\u7F29\u500D\u6570\uFF081.0=\u4E0D\u6536\u7F29\uFF0C0.8=\u7F29\u5C0F20%\uFF09").addSlider(
      (slider) => slider.setLimits(0.5, 1, 0.01).setValue(this.plugin.settings.debugActiveScale).setDynamicTooltip().onChange(async (value) => {
        this.plugin.settings.debugActiveScale = value;
        await this.plugin.saveSettings();
      })
    );
  }
};
