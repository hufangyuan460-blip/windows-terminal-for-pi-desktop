# 架构与关键决策

本文只记录"为什么这样做"，尤其是那些在别处看不出原因的选择。API 与用法见
[README.md](../README.md)，验证状态见 [TEST-REPORT.md](TEST-REPORT.md)。

## 1. 进程与数据流

```text
PI-Desktop 主进程
├─ 插件进程（utility process，Node）：main.js + lib/*
│   ├─ 标签管理（lib/session.js）：每个标签一个 helper 客户端 + 一个有界输出环形缓冲
│   ├─ 回环事件服务（lib/loopback.js）：127.0.0.1 随机端口 + 每次启动的随机 token
│   └─ 每个终端标签：helper/bin/win-x64/pi-conpty-helper.exe
│        └─ ConPTY 伪终端
│             └─ PowerShell 7 / Windows PowerShell 5.1 / cmd
└─ 工作面板视图（WebContentsView，file:// + plugin-panel preload）
    └─ xterm.js 渲染；输入/缩放经 pluginBridge → 插件进程
```

输入、缩放、中断：`pluginBridge.invoke` → `onPanelInvoke` → 辅助程序（JSON Lines over stdin）。
输出：辅助程序 stdout → 插件进程 → 环形缓冲 → 回环 SSE（首选）/ 宿主桥轮询（兜底）→ 面板。

## 2. 为什么需要一个回环 HTTP 服务

PI-Desktop 0.17.0 给插件面板的是**请求/响应**桥（`pluginBridge.invoke` →
`onPanelInvoke`），以及宿主自己固定事件的广播（`appearance:changed` 等）。
宿主源码里的广播注释写得很清楚：*"the event names are fixed by the host"*。
终端输出是持续的流，因此输出通道由插件自己提供：

- 主通道：`http://127.0.0.1:<随机端口>/v1/events`（SSE，带序号可续传）。
- 兜底：`pluginBridge.invoke('read', { cursors })` 轮询同一个环形缓冲。

两条通道走同一份带序号的数据，所以即使事件流被拒（宿主会话级出入站策略、企业代理、
PNA 预检等），面板仍然完整可用 —— 只是延迟从毫秒级变成几十毫秒级。面板会在状态栏
PNA 预检等），面板仍然完整可用 —— 只是延迟从毫秒级变成几十毫秒级。面板会在「终端详情」
里显示当前通道，并把结果回报给插件日志，便于事后判断。
**为什么面板能访问 127.0.0.1**：插件视图的会话被宿主加上 `onBeforeRequest` 出入站策略，
只允许 `file:`/`data:`/`blob:` 等本地 scheme 以及 manifest `net.domains` 里声明的域名
（匹配时只看主机名，忽略端口）。因此 manifest 声明 `"net": { "domains": ["127.0.0.1"] }`。
这**不是**通用网络授权，也**不是** `net.fetch`：插件进程从不用宿主网络 API。

## 3. ConPTY 是什么（为什么不能拿管道冒充终端）

**ConPTY = Windows Console Pseudo Terminal（伪控制台）**，是 Windows 10 1809（build 17763）
起提供的系统 API。它让一个普通程序在不打开窗口的情况下驱动一个**真正的**控制台程序
（PowerShell / cmd / 任何命令行工具），并像终端一样收发字节流。Unix 上的对应物叫 `pty`；
Windows 长期没有，ConPTY 是官方补上的那一块（此前得靠 winpty / ConEmu 这类第三方方案）。

没有它的时候，程序想让子进程"像在终端里那样"运行，只能给子进程接一对匿名管道
（stdin / stdout）—— 而管道不是终端：

| 用普通管道 | 用 ConPTY |
| --- | --- |
| 没有 ANSI 转义、颜色、光标移动 | 完整的 VT/ANSI 字节流 |
| 没有"窗口尺寸"概念，无法 resize | 尺寸可设，`ResizePseudoConsole` 随面板变化 |
| 程序检测到"我不是在终端里"，走非交互分支 | 程序以为自己在真终端里，行为与手敲一致 |
| 提示符重绘、进度条、`Get-Content -Wait`、交互式提问都不正常 | 与手敲一致 |
| Ctrl+C 语义得自己伪造 | 控制台事件语义由系统维护 |

所以本插件不做"管道模拟终端"：面板是 xterm.js（只负责把 VT 字节流画出来），真正驱动
控制台的是 `pi-conpty-helper.exe`。一次会话的建立过程（`helper/NativeMethods.cs`、
`helper/PtySession.cs`）：

1. `CreatePseudoConsole(尺寸, 输入管道, 输出管道, …)` 得到一个 `HPCON`（伪终端句柄）；
2. 把 `HPCON` 作为进程属性（`PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`）放进 `STARTUPINFOEX`；
3. `CreateProcess` 启动 Shell —— 它挂在这个伪终端上，以为自己接在一个真实控制台后面；
4. 插件从此读到的是终端字节流（含 ANSI），写进去的是键盘输入字节流；
   `ResizePseudoConsole` 改尺寸，`ClosePseudoConsole` 收尾。

系统要求 **Windows 10 1809+ / Windows 11** 就是从这里来的。实测证据：`mode con` 报告的
尺寸随 `ResizePseudoConsole` 变化（见 TEST-REPORT §2.3）；代码页与字节流的关系见第 5 节，
进程清理见第 6 节。

## 4. ConPTY 辅助程序（C#）

不使用 `node-pty`：它的原生模块与 Electron/Node ABI 绑定，插件进程一旦升级宿主就可能
加载失败。改为一个自包含、单文件、裁剪发布的 .NET 8 控制台程序：

- 由插件通过 `child_process.spawn` 启动，只走 stdin/stdout 管道（无可见窗口）。
- 协议为 UTF-8 JSON Lines：`start / input / resize / signal / close / ping`；
  事件 `hello / ready / output / exit / error / ok`。
- 终端数据一律 **base64 原始字节**，不做任何字符串转码 —— 跨分块的多字节字符因此不可能被截断。
- 诊断日志只写 stderr，stdout 永远是纯协议流。

### 4.1 两个必须踩到的坑（都已在真实环境复现并修正）

**(a) `STARTUPINFOEX` 的布局必须与 C 结构完全一致。**
把 `lpReserved/lpDesktop/lpTitle` 声明为 `string` 会让结构体变成非 blittable，
`lpAttributeList` 落到错误的偏移上，伪终端属性被静默丢弃：`CreateProcess` 照样成功，
但 Shell 会挂到父进程的控制台上（或继承父进程的标准句柄），输出管道立即
`ERROR_BROKEN_PIPE`。修正办法是所有指针字段都用 `IntPtr`。辅助程序的 `--selftest`
会打印实测布局（`STARTUPINFO=104 STARTUPINFOEX=112 lpAttributeList@104 hStdInput@80`）
并在后续版本里持续验证。

**(b) 必须显式要求"控制台自己的标准句柄"。**
只给伪终端属性还不够：需要用 `STARTF_USESTDHANDLES` + 三个 `INVALID_HANDLE_VALUE`
（外加 `STARTF_USESHOWWINDOW`/`SW_HIDE`），控制台子系统才会把**新控制台**的
标准句柄装给子进程。否则子进程保留父进程的句柄值，输出跑到插件进程的管道里。
`--selftest --variant=parent-std-handles` 保留了这个失败模式作为回归证据。

另外，控制台侧的管道端（`inputRead`/`outputWrite`）**必须在 `CreateProcess` 之后**关闭，
提前关闭会让伪终端不可用。

## 5. 编码：为系统代码页保持原样

实测（Windows 10 19045，OEM/ANSI 代码页 936）：

- ConPTY 的字节流**双向都是 UTF-8**，与控制台代码页无关。
- 因此 `chcp 65001` 既非必要也有副作用：窗口标题会变成 `cmd.exe - chcp 65001`，
  且切换瞬间的第一行回显会被破坏（实测出现过半个汉字）。
- 不改代码页时，依赖 `GetConsoleCP()` 的老工具仍按自己的代码页正常工作。

结论：**不碰代码页**，原始字节透传到 xterm.js（xterm 的 `write(Uint8Array)` 自带
跨分块 UTF-8 解码）。`lib/shells.js` 仍然读取并暴露代码页信息，仅用于诊断。

## 6. 清理与"不残留 Shell"

`pi-conpty-helper.exe` 在创建 Shell 时把它放进一个
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的 Job Object。于是：

| 触发 | 结果 |
| --- | --- |
| 关闭标签 | 插件发 `close` → helper 结束 Job → Shell 树消失 |
| 卸载插件 | `onUnload` → 逐个关闭 → 停止回环服务 |
| 插件进程崩溃 | helper 的 stdin EOF → 自杀 → 关闭 Job 句柄 → Shell 树消失 |
| helper 被强杀 | 进程死亡 → 内核关闭 Job 句柄 → Shell 树消失 |

不依赖"按进程名杀进程"。嵌套 Job 环境（宿主自身在 Job 里）下 `AssignProcessToJobObject`
可能失败，此时 helper 会记录警告并继续工作：`close`/`kill` 的显式终止仍然有效。

## 7. 资源上限

| 项 | 位置 | 值 |
| --- | --- | --- |
| 标签数 | `lib/session.js`（设置 `maxTabs`） | 8（1–16） |
| 每标签输出缓存 | `lib/ring.js`（设置 `scrollbackKiB`） | 256 KiB（16–4096） |
| 单次轮询回复 | `lib/session.js` | ≤192 KiB（面板请求上限 512 KiB） |
| SSE 积压回放 | `lib/loopback.js` | ≤512 KiB / 2048 块 |
| 单次输入 | `lib/session.js` | 64 KiB |
| SSE 客户端数 | `lib/loopback.js` | 8 |
| helper 单行协议长度 | `helper/Program.cs` | 8 MiB |
| 面板待写队列 | `renderer/app.js` | 4 MiB；每帧写 ≤512 KiB |

输出合并：插件侧 12 ms 或 64 KiB 先到者触发一次入环 + 广播；面板侧按
`requestAnimationFrame` 分批写入 xterm。高频输出既不会无限增长内存，也不会卡住界面；
超限时丢弃最旧数据并明确提示"已丢弃约 N 字节"。

## 8. 安全边界

- 回环服务只绑定 `127.0.0.1`，端口随机；token 为 32 随机字节（base64url），
  常数时间比较；未携带/错误 token 一律 403 且不返回任何数据。
- token 只经宿主的 `pluginBridge.invoke` 交给本插件自己的面板（`state` 通道）；
  不写日志、不落盘、不放进任何会被记录的位置。
- CORS 与 `Access-Control-Allow-Private-Network` 只是让 `file://` 面板能读响应，
  鉴权仍然只看 token。
- 没有任何端点接受"要执行的命令"：输入与缩放经宿主桥进入伪终端；`/v1/state` 只读。
- 插件不申请 `fs.*`、`net.fetch`、`shell.openExternal`、`agent.*`：
  它不需要读项目文件、不需要出网、不把终端内容交给 AI。

## 9. 面板侧

- 视图入口 `renderer/index.html`，`<meta name="pi-plugin-chrome" content="v2">`；
  顶栏不是宿主拖拽区，布局用 `padding-top: var(--pi-plugin-titlebar-height, 0px)` 自适应。
- 每个标签一个 xterm 实例，只显示当前标签；隐藏标签仍接收数据（进入队列）以便切回即见。
- 主题/语言跟随 `app.getAppearance()` 与 `appearance:changed`；中文优先，英文兜底。
- 输入按 8 ms 合并后经宿主桥发送；不本地回显（回显由 Shell 自己产生）。
- `Ctrl+C`：有选区复制，无选区发送 `\x03`；`Ctrl+V` 交给浏览器原生粘贴，
  `Ctrl+Shift+V` 走插件剪贴板通道；右键菜单提供同样的入口。
- 控制栏是**单行**：当前终端按钮（状态圆点 + 名称 + 下拉列表）＋ `＋` / `▾` / `⋯`；
  运行状态、Shell 路径、启动目录、终端尺寸与输出通道不再常驻界面，收进「终端详情」。

## 10. 已知边界

- 只支持 x64（未做 arm64 发布）。
- 一个辅助进程一个终端，因此标签数上限同时是进程数上限。
- `cmd` 无法以 UNC 路径作为工作目录（这是 cmd 自身行为），插件会在面板上提示。
- PowerShell 7 未安装时不显示该项，而不是给一个点不动的入口。
