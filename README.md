# rr_obsd

Tori 的 Obsidian 插件工具箱：一个插件，三个功能，各自独立开关。

| 模块 | 功能 |
| --- | --- |
| **Table Row Number** | 表格行号、起始序号、数字/字母/罗马格式、字体和自动列宽 |
| **Floating New Note** | 编辑区悬浮新建按钮；默认在当前笔记同级目录新建，也可指定固定目录 |
| **Vault Watch** | 补充 Windows 原生文件通知，让 SMB / NAS 仓库显示外部文件和目录变化 |

首次安装会尝试迁移旧 `table-row-number`、`floating-new-note` 插件的设置。使用整合版时应停用对应独立插件，避免重复按钮和监听。

当前版本为 **0.3.0**，已通过 91 项自动化测试和 9 项实际 Obsidian 界面检查。环境、验收范围与尚未覆盖的场景见 [验证记录](docs/VALIDATION.md)。

## 安装与升级

要求 Obsidian **1.13.7 或更新版本**。Vault Watch 需要 Windows；其余两个模块不依赖 Windows 原生监听。

1. 从 [Releases](https://github.com/tori-RR/rr_obsd/releases) 获取已发布的安装包，或运行 `npm run package` 构建当前源码。
2. 解压后，将完整的 `rr_obsd` 目录放入仓库的 `.obsidian/plugins/`。使用自定义配置目录时，放入对应的 `plugins/` 目录。
3. 在 Obsidian「设置 → 第三方插件」启用 **RR Obsd Toolbox**，按需启用三个模块。

安装目录至少应包含：

```text
<vault>/.obsidian/plugins/rr_obsd/
  main.js
  manifest.json
  styles.css
  native/
    watch.ps1
```

**必须保留 `native/watch.ps1`**；只复制三个顶层插件文件无法运行 Vault Watch。安装包还带有版本、许可和使用文档。

升级前备份现有 `rr_obsd` 目录；停用插件后替换发行文件，保留现有 `data.json`，再启用。回滚时停用插件并恢复备份目录。先在独立测试仓库或已获授权的临时测试目录验证，再用于日常笔记。

## 外部修改如何刷新

Vault Watch 按文件事件核对索引，默认在当前 Markdown 笔记上每 5 秒补查一次，弥补内容修改通知丢失。全库安全核对默认在上次核对完成 180 秒后再次安排；两项间隔均可调整，设为 0 可关闭。网络和扫描耗时会影响实际刷新时间。

有未保存输入或正在保存时，插件保留编辑内容并提示检查外部变化。它不提供并发编辑合并或笔记备份。使用方法和通知限制见 [Vault Watch](docs/VAULT-WATCH.md)。

## 开发

使用 Node.js 22+；Windows 会运行真实 PowerShell 辅助进程测试。

```powershell
npm ci --ignore-scripts
npm run check
npm run package
```

| 目录 | 用途 |
| --- | --- |
| `src/main.js` | 整合插件入口和共享设置 |
| `src/modules/` | 三个功能模块 |
| `src/vault-watch/` | 原生桥接、核对引擎、宿主适配和安全视图刷新 |
| `native/` | 随安装包分发的 Windows 监听辅助程序 |
| `tests/` | 单元测试和真实进程测试 |
| `scripts/` | 检查、构建、打包及需显式启用的界面验收 |
| `docs/` | 架构、使用、验证和来源记录 |

`src/` 是当前实现的唯一维护入口。旧独立插件保存在 Git 历史中，精确恢复来源见 [历史插件记录](docs/LEGACY-PLUGINS.md)。构建产物 `main.js` 和 `dist/` 不进入 Git。

更多开发约束见 [AGENTS.md](AGENTS.md)，实现细节见 [架构](docs/ARCHITECTURE.md)。

## License

[MIT](LICENSE)
