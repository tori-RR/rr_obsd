# Changelog

## 0.2.1 — 2026-09-08

- Vault Watch：外部修改事件后主动刷新聚焦中的编辑器内容（保留光标与滚动位置），修复「打开着的笔记要切换一次才看到更新」的滞留

## 0.2.0 — 2026-09-08

- Floating New Note：目标文件夹新增「当前笔记同级目录」模式并设为默认；取不到活动笔记时回退到固定文件夹

## 0.1.0 — 2026-09-08

首次发布：整合版插件（Tori 的 Obsidian 插件工具箱）。

- **Table Row Number**（表格行号）：自同名独立插件移植，功能与交付版 v1.10 一致
- **Floating New Note**（悬浮新建笔记）：自同名独立插件移植，版本 v1.3.0
- **Vault Watch**（NAS 原生监听）：自 obsidian-vault-watch v0.1.0 移植，`lib/` 子系统与测试链保持不变
- 统一设置面板，三个模块独立开关
- 首次安装时自动迁移旧独立插件（table-row-number / floating-new-note）的 `data.json` 设置
