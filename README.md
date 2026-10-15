# Windows ConPTY Terminal — PI-Desktop 插件

在 PI-Desktop 的**工作面板**中提供真正的 Windows 交互式终端：xterm.js 前端 + 自带的
ConPTY 辅助程序（C# / .NET 8，自包含单文件）。你输入的命令以你的用户身份在真实控制台里
执行，终端内容**不会**交给 AI。

- 插件 ID：`io.github.hufangyuan460-blip.windows-terminal`（发布者命名空间；与官方的 `pi.terminal` 无关）
- 目标平台：Windows 10 1809+ / Windows 11，x64
- 依赖：无。不需要 Node、Python、.NET 运行时（辅助程序已随插件打包）

## 功能

| 能力 | 说明 |
| --- | --- |
| 真实伪终端 | 每个标签一个 ConPTY 伪终端 + 一个辅助进程 + 一个 Shell |
| Shell | PowerShell 7（已安装时优先）、Windows PowerShell 5.1、命令提示符 cmd |
| 多标签 | 单行控制栏：**当前终端**按钮（状态圆点 + 名称 + 下拉列表）＋ `＋` / `▾` / `⋯` 三个图标按钮，终端占满其余空间；标签之间互不串流 |
| 中文 | 输入输出 UTF-8；IME、中文路径、含空格路径均可用 |
| 终端语义 | ANSI 颜色、光标移动、Tab、方向键、Backspace、宽字符 |
| Ctrl+C | 无选区时发送中断；有选区时复制（见快捷键） |
| 窗口缩放 | 面板尺寸变化同步 `ResizePseudoConsole` |
| 复制粘贴 | 宿主剪贴板（需要插件权限），另有右键菜单入口 |
| 会话存活 | 面板隐藏/关闭不结束 Shell；重新打开继续看输出 |
| 清理 | 关闭标签、卸载插件、退出应用、插件进程崩溃都不会残留 Shell |

## 安装

1. 打开 PI-Desktop → 插件页面 → 从文件安装。
2. 选择 `dist/io.github.hufangyuan460-blip.windows-terminal-1.1.2.piplug`。
3. 确认权限：`ui.view`（工作面板视图）、`clipboard.read` / `clipboard.write`（复制粘贴）。
   可选网络范围只有 `127.0.0.1` —— 面板要访问插件自己的回环事件流。

安装后在工作面板的视图列表里选择**终端**。

## 使用

- 打开面板：工作面板 → 视图列表 → **终端**。首次打开会自动新建一个终端。
- 控制栏（单行）：左侧是**当前终端**按钮（状态圆点 + 名称 + 下拉），点开是终端列表（同名终端带
  `#1` / `#2` 区分，超长时内部滚动）；右侧三个图标按钮 = `＋` 新建默认 Shell、`▾` 选 Shell 新建、
  `⋯` 更多操作。
- `⋯` 菜单：清屏、重启当前终端、**终端详情**，底部用分隔线单列**关闭当前终端**。
- **终端详情**：Shell 名称与 PID、Shell 完整路径、启动目录、终端尺寸、运行状态、输出通道
  （事件流 / 轮询）。这些不再占用常驻状态栏；正常运行只用控制栏的状态圆点表示。
- 终止或异常时面板底部出现紧凑提示，并给出重启入口。
- 右键终端内容：复制 / 粘贴 / 清屏 / 重启 / 详情 / 关闭；菜单支持方向键、`Home`/`End`、`Esc`
  关闭并把焦点还给按钮。
- 命令面板：`终端: 新建终端`（在后台新建一个终端标签）。

### 快捷键

| 快捷键 | 行为 |
| --- | --- |
| `Ctrl+C` | 有选区：复制；无选区：向 Shell 发送中断（`^C`） |
| `Ctrl+Shift+C` | 复制选中内容 |
| `Ctrl+V` / `Ctrl+Shift+V` | 粘贴（`Ctrl+V` 走浏览器原生粘贴） |
| `Ctrl+Shift+T` | 新建终端 |
| `Ctrl+Shift+W` | 关闭当前终端 |
| `Ctrl+Shift+R` | 重启当前终端 |
| `Ctrl+Shift+K` | 清屏（只清显示，不影响 Shell） |
| 右键 | 复制 / 粘贴 / 清屏 / 重启 / 关闭 |
| `Ctrl+Shift+滚轮`（xterm 默认） | 调整字号 |

## 工作目录

- 有打开的项目：默认项目**主根目录**（多文件夹项目取宿主标注的主根）。
- 未打开项目：用户目录，状态栏会写明「未打开项目，已使用用户目录」。
- 目录不存在或 UNC 路径无法启动时：回退到用户目录并在面板上说明原因。
- 创建终端时固定目录；切换项目不会悄悄改变已在运行的 Shell。

## 设置

插件页面里的插件设置：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `defaultShell` | `auto` | `auto` 表示优先 PowerShell 7，其次 Windows PowerShell 5.1，最后 cmd |
| `maxTabs` | `8` | 终端数量上限（1–16），达到上限时新建会被拒绝并提示 |
| `scrollbackKiB` | `256` | 每个标签保留的输出上限（16–4096 KiB），超出后丢弃最旧输出并提示 |

## 架构（一句话版）

面板 = xterm.js + 宿主桥；插件进程 = 标签管理 + 回环 SSE；每个标签一个
`pi-conpty-helper.exe` 管一个 ConPTY。细节与取舍见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 故障排查

| 现象 | 处理 |
| --- | --- |
| 面板提示「插件缺少 ConPTY 辅助程序」 | 重新安装完整插件包；若从源码运行，先执行 `tools/build-helper.ps1` |
| 输入没有反应 | 看状态栏的输出通道：若显示「轮询」说明事件流被拒，插件仍可用，只是延迟略高 |
| Shell 启动后立刻退出 | 查看面板底部提示（会给出退出码与原因），可点「重启」 |
| 输出乱码 | 请连同 `Shell`、代码页与实际命令提交问题；当前实现是原始字节透传（UTF-8） |
| 中文文件名显示异常 | 确认不是旧版本 Windows 的终端字体问题；可换用 Windows Terminal 同款字体 |
| 终端数量到上限 | 关闭不用的标签，或调高 `maxTabs` 设置 |
| 面板打开很慢 | 首次加载要从磁盘读 xterm.js（约 290 KB，随插件打包，不走 CDN） |

### 日志

插件日志写入 PI-Desktop 的插件日志（`%USERPROFILE%\.pi-desktop\logs\app\plugin.log`），
前缀 `[io.github.hufangyuan460-blip.windows-terminal]`。日志里**不会**出现回环 token、你的输入或终端输出。

## 卸载

1. 插件页面 → 卸载。卸载会结束该插件所有终端及其 Shell 进程树。
2. 若想同时清理数据目录：`%USERPROFILE%\.pi-desktop\plugins\data\io.github.hufangyuan460-blip.windows-terminal`。

## 隐私与安全

- 终端内容只在本机流动：面板 ←（回环 SSE 或宿主桥）← 插件进程 ← ConPTY。
- 回环服务只绑定 `127.0.0.1`，端口随机；每次插件启动生成新的 32 字节 token，
  每个请求都要带 token（常数时间比较），未携带或错误一律 403。
- token 只通过宿主插件桥交给本插件自己的面板，不写入日志、文件或 URL 记录。
- 插件没有任何「执行任意命令」的 HTTP 入口：输入与缩放都经宿主桥进入伪终端。
- CORS 头只是让 `file://` 面板能读响应，不参与鉴权。
- 不把终端内容交给 AI、不联网上传、不读取项目文件（插件不需要 `fs.*` 权限）。

## 开发与验证

```powershell
# 构建 ConPTY 辅助程序（需要 .NET 8 SDK；产物为单文件自包含 exe）
powershell -ExecutionPolicy Bypass -File tools/build-helper.ps1

# 全量验证：辅助程序自检 + 45 个自动化测试
powershell -ExecutionPolicy Bypass -File tools/run-tests.ps1

# 手动观察真实 Shell（打印转写与十六进制，用于排查编码/尺寸问题）
node tools/helper-probe.cjs cmd powershell interrupt

# 面板渲染 harness：生成注入假宿主桥的面板页面（含 280/320/400/600px 宽度页），用应用内浏览器打开
powershell -ExecutionPolicy Bypass -File tools/panel-harness.ps1

# 应用内端到端自检：在插件数据目录放 selftest.request 后重新加载插件
```

当前验证状态（自动化通过 / 应用内已验证 / 未验证）见
[docs/TEST-REPORT.md](docs/TEST-REPORT.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。随包分发的第三方资源与声明见
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
