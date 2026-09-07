const { Plugin, PluginSettingTab, Setting, Notice, setIcon } = require("obsidian");

const DEFAULT_SETTINGS = {
  enabled: true,
  startFrom: 1,
  format: "decimal",
  separator: ". ",
  fontFamilyPreset: "inherit",
  customFontFamily: "",
  fontSize: "1em",
  fontWeight: "600"
};

const FONT_PRESETS = {
  "inherit":  { label: "跟随主题（默认）", stack: "inherit" },
  "mono":     { label: "系统等宽（推荐序号）", stack: `ui-monospace, SFMono-Regular, "SF Mono", "JetBrains Mono", "Fira Code", Consolas, "Liberation Mono", Menlo, monospace` },
  "serif":    { label: "优雅衬线", stack: `Georgia, "Times New Roman", "Songti SC", "STSong", "Noto Serif CJK SC", serif` },
  "sans":     { label: "现代无衬线", stack: `system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif` },
  "rounded":  { label: "圆润可爱", stack: `"SF Pro Rounded", "Nunito", "Quicksand", "Comic Sans MS", system-ui, sans-serif` },
  "display":  { label: "标题装饰", stack: `"Playfair Display", "DIN Alternate", "Bebas Neue", Georgia, serif` }
};

const CHAR_WIDTH = {
  "decimal": 0.62, "lower-alpha": 0.55, "upper-alpha": 0.72,
  "lower-roman": 0.5, "upper-roman": 0.72
};

// 探测常见字体候选
const FONT_CANDIDATES = [
  "Microsoft YaHei", "微软雅黑", "PingFang SC", "苹方", "Hiragino Sans GB",
  "Songti SC", "宋体", "SimSun", "SimHei", "黑体", "KaiTi", "楷体",
  "FangSong", "仿宋", "STHeiti", "STSong", "STKaiti", "STFangsong",
  "Noto Sans CJK SC", "Noto Serif CJK SC", "Source Han Sans CN",
  "Source Han Serif CN", "思源黑体", "思源宋体", "LXGW WenKai", "霞鹜文楷",
  "Arial", "Helvetica", "Times New Roman", "Georgia", "Verdana", "Tahoma",
  "Trebuchet MS", "Courier New", "Impact", "Comic Sans MS", "Segoe UI",
  "Calibri", "Cambria", "Consolas", "Lucida Console", "Palatino",
  "Book Antiqua", "Garamond", "Century Gothic",
  "SF Pro", "SF Pro Display", "SF Pro Text", "SF Pro Rounded", "SF Mono",
  "Menlo", "Monaco", "Optima", "Futura",
  "JetBrains Mono", "Fira Code", "Cascadia Code", "Cascadia Mono",
  "Source Code Pro", "Ubuntu Mono", "Roboto Mono", "IBM Plex Mono",
  "Hack", "Inconsolata", "DejaVu Sans Mono",
  "Roboto", "Open Sans", "Lato", "Montserrat", "Poppins", "Inter",
  "Noto Sans", "Ubuntu", "DejaVu Sans", "Liberation Sans",
  "Nunito", "Quicksand", "Playfair Display", "Bebas Neue"
];

async function detectSystemFonts() {
  if (typeof window.queryLocalFonts === "function") {
    try {
      const fonts = await window.queryLocalFonts();
      const families = [...new Set(fonts.map((f) => f.family))];
      families.sort((a, b) => a.localeCompare(b, "zh-CN"));
      return { source: "queryLocalFonts", families };
    } catch (e) { console.warn("queryLocalFonts failed:", e); }
  }
  const available = FONT_CANDIDATES.filter((f) => isFontInstalled(f));
  available.sort((a, b) => a.localeCompare(b, "zh-CN"));
  return { source: "probe", families: available };
}

function isFontInstalled(family) {
  const testString = "mmmmmmmmmmlliMMMMMMMMWWWWW中文测试0123";
  const fallback = "monospace";
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  ctx.font = `72px ${fallback}`;
  const fw = ctx.measureText(testString).width;
  ctx.font = `72px "${family}", ${fallback}`;
  return ctx.measureText(testString).width !== fw;
}

class TableRowNumberPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.addSettingTab(new TableRowNumberSettingTab(this.app, this));
    this.applyStyle();
    this.startAutoSize();
    this.addRibbonToggle();
    this.addCommand({
      id: "toggle-table-row-number",
      name: "切换表格行号显示",
      callback: () => this.toggleEnabled()
    });
  }

  onunload() {
    this.removeStyle();
    this.stopAutoSize();
  }

  addRibbonToggle() {
    this.ribbonIconEl = this.addRibbonIcon("list-ordered", "切换表格行号显示",
      () => this.toggleEnabled());
    this.updateRibbonState();
  }

  updateRibbonState() {
    if (!this.ribbonIconEl) return;
    if (this.settings.enabled) {
      this.ribbonIconEl.addClass("is-active");
      this.ribbonIconEl.setAttribute("aria-label", "表格行号：已开启");
    } else {
      this.ribbonIconEl.removeClass("is-active");
      this.ribbonIconEl.setAttribute("aria-label", "表格行号：已关闭");
    }
  }

  async toggleEnabled() {
    this.settings.enabled = !this.settings.enabled;
    await this.saveSettings();
    this.reapply();
    this.updateRibbonState();
    new Notice(this.settings.enabled ? "表格行号：已开启" : "表格行号：已关闭", 1500);
  }

  resolveFontFamily() {
    const custom = (this.settings.customFontFamily || "").trim();
    if (custom) {
      // 如果用户只输入字体名（不带引号/fallback），自动包装
      if (!custom.includes(",") && !custom.includes('"') && !custom.includes("'")) {
        return `"${custom}", sans-serif`;
      }
      return custom;
    }
    const preset = FONT_PRESETS[this.settings.fontFamilyPreset] || FONT_PRESETS.inherit;
    return preset.stack;
  }

  fontSizeFactor() {
    const s = (this.settings.fontSize || "1em").trim();
    const m = s.match(/^([\d.]+)\s*(em|px|%)?$/i);
    if (!m) return 1;
    const num = parseFloat(m[1]);
    const unit = (m[2] || "em").toLowerCase();
    if (unit === "em") return num;
    if (unit === "%") return num / 100;
    if (unit === "px") return num / 16;
    return 1;
  }

  applyStyle() {
    this.removeStyle();
    if (!this.settings.enabled) return;

    const offset = this.settings.startFrom - 1;
    const sepRaw = this.settings.separator || "";
    const sepTrimmed = sepRaw.replace(/\s+$/, "");
    const trailingSpaces = sepRaw.length - sepTrimmed.length;
    const sep = sepTrimmed.replace(/"/g, '\\"');
    const padRight = (0.4 + trailingSpaces * 0.35).toFixed(2) + "em";
    const fmt = this.settings.format;
    const fontFamily = this.resolveFontFamily();
    const fontSize = this.settings.fontSize || "1em";
    const fontWeight = this.settings.fontWeight || "600";

    const style = document.createElement("style");
    style.id = "table-row-number-style";
    style.textContent = `
.markdown-preview-view table,
.markdown-source-view.is-live-preview table {
  counter-reset: row-num ${offset};
}
.markdown-preview-view table tbody tr,
.markdown-source-view.is-live-preview table tbody tr {
  counter-increment: row-num;
}
.markdown-preview-view table thead tr th:first-child,
.markdown-preview-view table tbody tr td:first-child,
.markdown-source-view.is-live-preview table thead tr th:first-child,
.markdown-source-view.is-live-preview table tbody tr td:first-child {
  padding-left: var(--trn-width, 3em) !important;
  position: relative;
}
.markdown-preview-view table tbody tr td:first-child::before,
.markdown-source-view.is-live-preview table tbody tr td:first-child::before {
  content: counter(row-num, ${fmt}) "${sep}";
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: var(--trn-width, 3em);
  padding-right: ${padRight};
  box-sizing: border-box;
  text-align: right;
  color: var(--text-muted);
  font-family: ${fontFamily};
  font-size: ${fontSize};
  font-weight: ${fontWeight};
  font-variant-numeric: tabular-nums;
  pointer-events: none;
  user-select: none;
  white-space: nowrap;
  overflow: hidden;
}
.side-dock-ribbon-action.is-active[aria-label*="行号"] {
  color: var(--interactive-accent);
}
/* 字体输入行的 refresh 按钮悬停 */
.trn-font-refresh {
  cursor: pointer;
}
.trn-font-refresh svg {
  transition: transform 0.3s;
}
.trn-font-refresh.is-loading svg {
  animation: trn-spin 0.8s linear infinite;
  transform-origin: center;
}
@keyframes trn-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
`;
    document.head.appendChild(style);
  }

  removeStyle() {
    const el = document.getElementById("table-row-number-style");
    if (el) el.remove();
  }

  computeWidth(rowCount) {
    if (rowCount <= 0) return "3em";
    let maxLabelLen;
    const fmt = this.settings.format;
    if (fmt === "decimal") {
      const maxNum = this.settings.startFrom + rowCount - 1;
      maxLabelLen = String(Math.max(1, maxNum)).length;
    } else if (fmt === "lower-alpha" || fmt === "upper-alpha") {
      maxLabelLen = rowCount <= 26 ? 1 : rowCount <= 702 ? 2 : 3;
    } else {
      maxLabelLen = rowCount < 4 ? 1 : rowCount < 9 ? 3 : rowCount < 39 ? 5 : 7;
    }
    const charW = CHAR_WIDTH[fmt] || 0.62;
    const sepW = (this.settings.separator || "").length * 0.35;
    const sizeFactor = this.fontSizeFactor();
    const decorMul = (this.settings.fontFamilyPreset === "display" ||
                      this.settings.fontFamilyPreset === "rounded") ? 1.15 : 1.0;
    const em = (maxLabelLen * charW + sepW) * sizeFactor * decorMul + 1.0;
    return em.toFixed(2) + "em";
  }

  resizeAll(root) {
    const scope = root || document;
    const tables = scope.querySelectorAll(
      ".markdown-preview-view table, .markdown-source-view.is-live-preview table"
    );
    tables.forEach((tbl) => {
      const rows = tbl.querySelectorAll("tbody tr").length;
      if (rows === 0) return;
      tbl.style.setProperty("--trn-width", this.computeWidth(rows));
    });
  }

  startAutoSize() {
    this.resizeAll();
    let raf = 0;
    const debounced = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; this.resizeAll(); });
    };
    this.observer = new MutationObserver(debounced);
    this.observer.observe(document.body, { childList: true, subtree: true });
    this.registerEvent(this.app.workspace.on("layout-change", debounced));
    this.registerEvent(this.app.workspace.on("active-leaf-change", debounced));
    this.registerEvent(this.app.workspace.on("resize", debounced));
  }

  stopAutoSize() {
    if (this.observer) { this.observer.disconnect(); this.observer = null; }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  reapply() {
    this.applyStyle();
    this.resizeAll();
  }
}

class TableRowNumberSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    this._fontsCache = null;
    this._datalistId = "trn-fonts-datalist";
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "基础" });

    new Setting(containerEl)
      .setName("启用行号")
      .setDesc("开启后，所有表格自动显示行号（宽度自动适配位数与字体缩放）")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.enabled).onChange(async (v) => {
          this.plugin.settings.enabled = v;
          await this.plugin.saveSettings();
          this.plugin.reapply();
          this.plugin.updateRibbonState();
        })
      );

    new Setting(containerEl)
      .setName("起始序号")
      .setDesc("行号从几开始（默认 1）")
      .addText((t) =>
        t.setValue(String(this.plugin.settings.startFrom)).onChange(async (v) => {
          const n = parseInt(v, 10);
          if (!isNaN(n)) {
            this.plugin.settings.startFrom = n;
            await this.plugin.saveSettings();
            this.plugin.reapply();
          }
        })
      );

    new Setting(containerEl)
      .setName("序号格式")
      .setDesc("数字、字母或罗马数字")
      .addDropdown((d) => {
        d.addOption("decimal", "1, 2, 3 ...")
          .addOption("lower-alpha", "a, b, c ...")
          .addOption("upper-alpha", "A, B, C ...")
          .addOption("lower-roman", "i, ii, iii ...")
          .addOption("upper-roman", "I, II, III ...")
          .setValue(this.plugin.settings.format)
          .onChange(async (v) => {
            this.plugin.settings.format = v;
            await this.plugin.saveSettings();
            this.plugin.reapply();
          });
      });

    new Setting(containerEl)
      .setName("序号后缀")
      .setDesc("序号后面的分隔符（如 . 或 ) 或空格）")
      .addText((t) =>
        t.setValue(this.plugin.settings.separator).onChange(async (v) => {
          this.plugin.settings.separator = v;
          await this.plugin.saveSettings();
          this.plugin.reapply();
        })
      );

    containerEl.createEl("h3", { text: "字体样式" });

    new Setting(containerEl)
      .setName("字体族预设")
      .setDesc("选择序号使用的字体分类；若下方自定义字体非空则以自定义为准")
      .addDropdown((d) => {
        Object.entries(FONT_PRESETS).forEach(([k, v]) => d.addOption(k, v.label));
        d.setValue(this.plugin.settings.fontFamilyPreset)
          .onChange(async (v) => {
            this.plugin.settings.fontFamilyPreset = v;
            await this.plugin.saveSettings();
            this.plugin.reapply();
          });
      });

    // === 合并：自定义字体（带 datalist 自动补全 + refresh 图标） ===
    this.buildCustomFontRow(containerEl);

    new Setting(containerEl)
      .setName("字号")
      .setDesc("相对单元格文字，例：1em / 1.1em / 14px")
      .addText((t) =>
        t.setValue(this.plugin.settings.fontSize).onChange(async (v) => {
          this.plugin.settings.fontSize = v.trim() || "1em";
          await this.plugin.saveSettings();
          this.plugin.reapply();
        })
      );

    new Setting(containerEl)
      .setName("字重")
      .setDesc("100 最细 → 900 最粗（默认 600 半粗）")
      .addSlider((sl) => {
        sl.setLimits(100, 900, 100)
          .setValue(parseInt(this.plugin.settings.fontWeight, 10) || 600)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.fontWeight = String(v);
            await this.plugin.saveSettings();
            this.plugin.reapply();
          });
      });
  }

  buildCustomFontRow(containerEl) {
    // 提前建 datalist 元素（挂在 containerEl 下，全局可引用）
    let datalist = containerEl.querySelector(`#${this._datalistId}`);
    if (!datalist) {
      datalist = containerEl.createEl("datalist", { attr: { id: this._datalistId } });
    }

    const setting = new Setting(containerEl)
      .setName("自定义字体")
      .setDesc("输入字体名即时搜索（点击右侧 ↻ 加载系统字体列表）；留空则使用上方预设");

    let textInput;
    setting.addText((t) => {
      textInput = t;
      t.setPlaceholder("输入字体名，如 Cascadia Code")
        .setValue(this.plugin.settings.customFontFamily)
        .onChange(async (v) => {
          this.plugin.settings.customFontFamily = v;
          await this.plugin.saveSettings();
          this.plugin.reapply();
        });
      t.inputEl.style.minWidth = "260px";
      t.inputEl.setAttribute("list", this._datalistId);
      // 自动补全属性
      t.inputEl.setAttribute("autocomplete", "off");
      t.inputEl.setAttribute("spellcheck", "false");
    });

    // Refresh 图标按钮（Lucide "refresh-cw"）
    setting.addExtraButton((btn) => {
      btn.setIcon("refresh-cw")
        .setTooltip("加载/刷新系统字体列表")
        .onClick(async () => {
          const iconEl = btn.extraSettingsEl;
          iconEl.classList.add("is-loading");
          try {
            const result = await detectSystemFonts();
            this._fontsCache = result;
            this.populateDatalist(datalist, result.families);
            new Notice(`已加载 ${result.families.length} 个字体（${result.source === "queryLocalFonts" ? "系统 API" : "探测法"}）`, 2000);
          } catch (e) {
            new Notice("字体加载失败：" + e.message, 3000);
          } finally {
            iconEl.classList.remove("is-loading");
          }
        });
      // 加个 CSS class 以支持 loading 旋转动画
      if (btn.extraSettingsEl) {
        btn.extraSettingsEl.classList.add("trn-font-refresh");
      }
    });

    // 如果之前已经加载过（同一次 display() 生命周期内），复用
    if (this._fontsCache) {
      this.populateDatalist(datalist, this._fontsCache.families);
    }
  }

  populateDatalist(datalist, families) {
    datalist.empty();
    families.forEach((f) => {
      const opt = datalist.createEl("option");
      opt.value = f;
    });
  }
}

module.exports = TableRowNumberPlugin;
