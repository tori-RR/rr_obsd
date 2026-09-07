# Vault Watch

让 NAS 上的 Obsidian 仓库及时显示外部文件变化。

**Vault Watch 是 Windows 桌面端的原生文件通知补充插件。** 当 SMB 仓库的文件已经被 AI、编辑器或脚本修改，Obsidian 却没有自动刷新时，它通过 Windows 原生通知驱动 Obsidian 重新核对文件。仓库仍直接打开在 NAS 上，不需要本地同步副本。

仓库名：`obsidian-vault-watch`；插件 ID：`vault-watch`。

## 状态

`0.1.0` 为预览版。针对 Obsidian **1.13.7 / Windows** 的实际内部接口实现，提供可安装 ZIP。已完成真实 Windows 通知测试和本地整条链路测试；**尚未完成本插件在实际 Obsidian 界面及生产 NAS 仓库内的安装验收**。具体证据和限制见 [验证记录](docs/VALIDATION.md)。

## 功能

- 外部新增、修改、删除、文件与目录重命名后，核对相关路径及目录子树。
- 正常运行按事件刷新；启动、重连、通知溢出、手动执行命令时核对全库。
- 网络恢复后重新挂接监听；辅助进程退出后自动重试。
- 设置中即时启用／暂停、显示状态栏、调整事件合并时间。
- 只读枚举文件列表；通过 Obsidian 适配器更新内存索引，不直接改写、移动或删除笔记。
- 不监听网络端口，不上传笔记，不创建本地笔记副本。

## 安装

1. 从本仓库的 [Releases](https://github.com/tori-RR/obsidian-vault-watch/releases) 下载 ZIP。私人仓库需要先登录获授权的 GitHub 账号。
2. 解压后，将整个 `vault-watch` 目录放进目标仓库的 `.obsidian/plugins/`。使用自定义配置目录时，放进相应的 `plugins/` 目录。
3. 在 Obsidian 的「设置 → 第三方插件」中启用 **Vault Watch**。首次复制后若列表尚未发现插件，可刷新插件列表或重载一次 Obsidian。
4. 状态栏显示「监听中」后，从外部修改一份测试笔记，检查正文和文件列表是否自动更新。

正确的安装结构：

```text
<vault>/.obsidian/plugins/vault-watch/
  main.js
  manifest.json
  native/
    watch.ps1
  README.md
  LICENSE
  CHANGELOG.md
  docs/
```

**必须一起安装 `native/watch.ps1`。** 仅复制 `main.js` 和 `manifest.json` 的安装方式不够。每个需要监听的仓库都需安装并启用插件；同时打开两个仓库会运行两个隐藏的辅助进程。

首次安装建议先在一个独立测试仓库验收。升级时保留旧插件目录作为回滚副本；停用插件后替换文件，再启用。回滚只需停用插件并还原旧目录。

## 使用

设置即时生效：

| 设置 | 默认值 | 作用 |
| --- | --- | --- |
| 原生文件监听 | 开启 | 启停当前仓库的辅助进程和事件处理 |
| 状态栏 | 显示 | 显示监听、核对、等待连接等状态 |
| 合并变化的等待时间 | 200 ms | 合并一批重复事件，可设为 100–1000 ms |

命令面板提供「核对外部文件变化」「重启原生监听」「启用／暂停原生监听」。暂停只关闭本插件，Obsidian 自身的监听仍按原方式工作。

## 原理和边界

```text
NAS / 本地文件系统
  → Windows .NET FileSystemWatcher
  → 隐藏的系统 Windows PowerShell 进程
  → JSON 文件事件
  → JavaScript 合并事件、核对路径
  → Obsidian 文件适配器队列与索引
```

插件使用系统自带 Windows PowerShell 5.1 和 .NET Framework，在辅助进程中编译小段 C#。不需要安装 SDK、下载原生 npm 模块或匹配 Electron ABI。运行时没有第三方 npm 依赖；不修改 PowerShell 执行策略。

它补充通知链路，不提供多端同步、版本合并、备份或冲突处理。外部重命名按原路径消失、新路径出现来核对索引；**不承诺自动改写笔记里的内部链接**。

请了解以下限制：

- 当前只支持 Windows。其他平台启用后显示不支持，不启动辅助进程。
- 使用 Obsidian 未公开保证兼容的 `adapter.queue` / `adapter.reconcileFile`。缺少接口会停止启动，但仅检查方法存在不能保证未来版本语义不变。
- 依赖 NAS 实际发送 SMB 文件通知。Windows 客户端经 SMB 修改的原生通知已验证；NAS 本机、Linux/NFS 客户端写入是否发通知，须在对应环境单独验收。
- 忽略任意以点开头的路径段（包括 `.obsidian`、`.git`），跳过符号链接、junction 和其他非普通文件/目录。
- 不执行周期性的全库扫描。每 5 秒做一次根目录可访问性探测；首次和恢复时的全库核对可能在大仓库上耗时。
- 完整枚举失败时不应用那份不完整的核对计划；断线使排队任务失效。已经进入 Obsidian 内部函数的操作无法撤回，本插件也不能阻止其他插件或 Obsidian 自身的写入行为。
- 企业策略若阻止 PowerShell 子进程或 `Add-Type`，辅助程序无法运行。插件不会尝试修改这些策略。

更多细节见 [架构](docs/ARCHITECTURE.md)。

## 开发

使用 Node.js 22+。源码为普通 JavaScript，测试采用 Node 内置测试框架；构建工具为锁定版本的 esbuild。

```powershell
npm ci --ignore-scripts
npm test
npm run build
npm run package
```

Windows 下会运行真实 PowerShell 文件通知测试；非 Windows 环境会跳过这些测试。构建产物为 `main.js`，安装包在 `dist/`。构建产物、用户设置和运行日志不进入 Git。

## 参考

- [Node.js fs.watch 的平台与网络文件系统限制](https://nodejs.org/api/fs.html#availability)
- [.NET FileSystemWatcher 缓冲区及网络目录限制](https://learn.microsoft.com/en-us/dotnet/api/system.io.filesystemwatcher.internalbuffersize?view=netframework-4.8.1)
- [Obsidian 官方插件模板](https://github.com/obsidianmd/obsidian-sample-plugin)

MIT License。
