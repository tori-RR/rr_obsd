# rr_obsd

Tori 的 Obsidian 插件工具箱 —— 一个插件，三个功能，各自独立开关。

## 功能

| 模块 | 功能 |
|---|---|
| **Table Row Number** | 自动为表格行添加序号：起始序号、数字/字母/罗马格式、字体预设与自定义字体、自动列宽 |
| **Floating New Note** | 编辑区左下角悬浮新建按钮：默认新建到当前笔记同级目录（可切换固定文件夹），热区、大小、偏移、透明度与图标可调 |
| **Vault Watch** | Windows 原生文件监听：让 SMB / NAS（如 TrueNAS）仓库上的外部修改自动刷新到 Obsidian 界面 |

三个模块均可在设置中单独启用/停用；从旧独立插件（table-row-number / floating-new-note）升级时，首次启动会自动迁移原有设置。

## 安装

手动安装（暂未上架社区市场）：

1. 从 [Releases](https://github.com/tori-RR/rr_obsd/releases) 下载 zip 解压，或将 `main.js`、`manifest.json`、`styles.css` 复制到 `.obsidian/plugins/rr_obsd/`
2. 在 Obsidian「设置 → 第三方插件」中启用 **RR Obsd Toolbox**

> Vault Watch 需要 Windows（借助 PowerShell 原生监听）；其余两个功能不受影响。要求 Obsidian ≥ 1.13.7。

## 开发

```bash
npm install        # 安装依赖
npm run check      # 语法检查 + 全部测试 + 构建
npm run build      # esbuild 打包 main.js
npm run package    # 构建并打出可安装 zip（dist/）
```

- 监听子系统（`lib/`、`native/watch.ps1`）的设计与验证记录见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 与 [docs/VALIDATION.md](docs/VALIDATION.md)
- [tools/](./tools/) 收录独立插件源（原 obsidian_plugin_draft 仓库迁入，独立版修改与测试在此进行）与 Obsidian 实用工具杂集

## 相关仓库

| 仓库 | 角色 |
|---|---|
| [obsidian-vault-watch](https://github.com/tori-RR/obsidian-vault-watch) | Vault Watch 独立版（维护中） |

## License

[MIT](./LICENSE)
