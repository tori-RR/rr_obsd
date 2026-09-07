'use strict';
// Floating New Note — 悬浮新建笔记模块（自 tori 的 floating-new-note 插件移植）。
// 按钮注入、透明度热区与图标选择器保持原实现；样式来自插件根 styles.css。
const { Setting, setIcon, getIconIds } = require('obsidian');

class FloatingNewNoteModule {
  constructor(host, settings, persist) {
    this.host = host;
    this.settings = settings;
    this.persist = persist;
  }

  async onload() {
    this.host.registerEvent(
      this.host.app.workspace.on("layout-change", () => this.injectAll())
    );
    this.host.registerEvent(
      this.host.app.workspace.on("resize", () => this.injectAll())
    );
    this.host.app.workspace.onLayoutReady(() => this.injectAll());
  }

  injectAll() {
    if (typeof this.host.app.workspace.getLeavesOfType !== "function") return;
    if (!this.settings.enabled) {
      this.removeAll();
      return;
    }
    const leaves = this.host.app.workspace.getLeavesOfType("markdown");
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
    setIcon(btn, this.settings.icon);
    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const app = this.host.app;
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
      setIcon(btn, this.settings.icon);
    }
  }

  removeAll() {
    if (typeof document === "undefined") return;
    document.querySelectorAll(".fab-container").forEach((el) => el.remove());
  }

  onunload() {
    this.removeAll();
  }

  renderSettings(containerEl, rerender = () => { containerEl.empty(); this.renderSettings(containerEl); }) {
    const { settings } = this;

    new Setting(containerEl).setName("启用悬浮按钮").setDesc("关闭后移除所有已注入的按钮").addToggle(
      (toggle) => toggle.setValue(settings.enabled).onChange(async (value) => {
        settings.enabled = value;
        await this.persist();
        this.injectAll();
      })
    );
    new Setting(containerEl).setName("目标文件夹").setDesc("新建笔记保存路径（相对 vault 根）。默认 New；留空则写到根目录").addText(
      (t) => t.setPlaceholder("New").setValue(settings.targetFolder ?? "New").onChange(async (value) => {
        settings.targetFolder = value.trim();
        await this.persist();
      })
    );
    const iconSetting = new Setting(containerEl).setName("图标").setDesc("点击输入框搜索，或直接输入 Lucide 图标名称");
    const pickerHost = iconSetting.controlEl.createDiv({ cls: "icon-picker-host" });
    new IconPicker(pickerHost, settings.icon, async (value) => {
      settings.icon = value;
      await this.persist();
    });
    new Setting(containerEl).setName("热区大小").setDesc("鼠标靠近多大的范围会触发显示（80~240px）").addSlider(
      (slider) => slider.setLimits(80, 240, 4).setValue(settings.zoneSize).setDynamicTooltip().onChange(async (value) => {
        settings.zoneSize = value;
        await this.persist();
      })
    );
    new Setting(containerEl).setName("按钮大小").setDesc("圆形按钮的直径（36~80px）").addSlider(
      (slider) => slider.setLimits(36, 80, 2).setValue(settings.fabSize).setDynamicTooltip().onChange(async (value) => {
        settings.fabSize = value;
        await this.persist();
      })
    );
    new Setting(containerEl).setName("水平偏移").setDesc("按钮离左边界的距离（0~80px）").addSlider(
      (slider) => slider.setLimits(0, 80, 2).setValue(settings.fabOffsetX).setDynamicTooltip().onChange(async (value) => {
        settings.fabOffsetX = value;
        await this.persist();
      })
    );
    new Setting(containerEl).setName("垂直偏移").setDesc("按钮离底边界的距离（0~80px）").addSlider(
      (slider) => slider.setLimits(0, 80, 2).setValue(settings.fabOffsetY).setDynamicTooltip().onChange(async (value) => {
        settings.fabOffsetY = value;
        await this.persist();
      })
    );
    new Setting(containerEl).setName("默认透明度").setDesc("热区外按钮的透明度（0=完全隐藏，1=完全不透明）").addSlider(
      (slider) => slider.setLimits(0, 1, 0.05).setValue(settings.opacity).setDynamicTooltip().onChange(async (value) => {
        settings.opacity = value;
        await this.persist();
        rerender();
      })
    );
    new Setting(containerEl).setName("热区悬停透明度").setDesc("0=和默认透明度一致，1=和按钮悬停透明度一致，中间值为两者插值").addSlider(
      (slider) => slider.setLimits(0, 1, 0.05).setValue(settings.hoverBlend).setDynamicTooltip().onChange(async (value) => {
        settings.hoverBlend = value;
        await this.persist();
      })
    );
    new Setting(containerEl).setName("按钮悬停透明度").setDesc("鼠标悬停在按钮上时的透明度（低于默认透明度时自动取默认值）").addSlider(
      (slider) => slider.setLimits(0, 1, 0.05).setValue(settings.btnOpacity).setDynamicTooltip().onChange(async (value) => {
        settings.btnOpacity = value;
        await this.persist();
        rerender();
      })
    );
    containerEl.createEl("hr");
    const debugHeader = containerEl.createDiv({ cls: "setting-item-description" });
    debugHeader.style.fontStyle = "italic";
    debugHeader.style.opacity = "0.6";
    debugHeader.setText("以下为开发者调试参数，确定效果后会删除");
    new Setting(containerEl).setName("[调试] 回弹放大倍数").setDesc("鼠标悬停时按钮放大倍数（1.0=不放大，1.2=放大20%）").addSlider(
      (slider) => slider.setLimits(1, 1.5, 0.01).setValue(settings.debugHoverScale).setDynamicTooltip().onChange(async (value) => {
        settings.debugHoverScale = value;
        await this.persist();
      })
    );
    new Setting(containerEl).setName("[调试] 点击收缩倍数").setDesc("点击按钮时收缩倍数（1.0=不收缩，0.8=缩小20%）").addSlider(
      (slider) => slider.setLimits(0.5, 1, 0.01).setValue(settings.debugActiveScale).setDynamicTooltip().onChange(async (value) => {
        settings.debugActiveScale = value;
        await this.persist();
      })
    );
  }
}

class IconPicker {
  constructor(container, value, onChange) {
    this.allIcons = [];
    this.isOpen = false;
    this.container = container;
    this.value = value;
    this.onChange = onChange;
    try {
      this.allIcons = getIconIds().sort();
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
      placeholder: "搜索图标…",
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
      setIcon(this.previewEl, this.value);
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
      this.dropdownEl.createDiv({ cls: "icon-picker-empty" }).setText("无匹配图标");
      return;
    }
    for (const iconId of matched) {
      const row = this.dropdownEl.createDiv({ cls: "icon-picker-row" });
      const iconEl = row.createDiv({ cls: "icon-picker-row-icon" });
      try {
        setIcon(iconEl, iconId);
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
}

module.exports = { FloatingNewNoteModule };
