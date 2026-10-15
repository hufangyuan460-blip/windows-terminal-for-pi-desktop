# 测试报告

> 结论口径：**自动化通过** = 本仓库脚本可复现；**应用内已验证** = 在真实 PI-Desktop 0.17.0
> 中观察到结果；**未验证** = 尚未在目标环境跑过，不做任何兼容性声明。
>
> 验证环境：Windows 10 19045（x64，OEM/ANSI 代码页 936），PI-Desktop 0.17.0，
> Node v24.19.0，.NET SDK 8.0.426。
> **本机未安装 PowerShell 7**，因此 `pwsh` 相关路径只做了代码级处理，未做真机运行验证。

## 1. 复现方式

```powershell
powershell -ExecutionPolicy Bypass -File tools/run-tests.ps1
```

脚本依次执行：辅助程序自检（ConPTY 管线）→ 54 个 Node 自动化测试。
`.NET 8 SDK` 仅构建辅助程序时需要；只跑测试时若 `helper/bin/win-x64/pi-conpty-helper.exe`
已存在则不重新构建。

## 2. 自动化通过（可复现）

最近一次运行：`SELFTEST PASS`，`tests 54 / pass 54 / fail 0`，脚本退出码 0。

### 2.1 辅助程序自检 `pi-conpty-helper.exe --selftest`

| 检查 | 结果 |
| --- | --- |
| 结构体布局实测 | `STARTUPINFO=104 STARTUPINFOEX=112 lpAttributeList@104 hStdInput@80`（与 C 结构一致） |
| 管道自环读写 | OK（16 字节写入/读出） |
| 生产变体（`conpty`） | `cmd /c echo` 通过伪终端输出被读到，`SELFTEST PASS` |
| 回归变体（`parent-std-handles`） | 按预期复现失败（子进程继承父标准句柄 → 管道立刻断开），作为修复证据保留 |
| 回归变体（`bogus-console`） | 传入伪造 HPCON 时 `CreateProcess` 失败，证明属性列表确实被读取 |

### 2.2 Node 测试（54 项）

`tests/ring.test.cjs`（5）— 序号单调、字节/块上限、单次读取上限、溢出记账、`clear()` 不重置序号。

`tests/shells.test.cjs`（10）— `%VAR%` 展开、PATH 切分与去引号、`reg query` 解析、
按 PATHEXT 查找可执行文件、工作目录校验与回退原因、引号处理、发现结果不变量、
优先级顺序（pwsh → Windows PowerShell → cmd）、`planLaunch` 参数为数据且校验 cwd、
用户输入不会变成 Shell 命令。

`tests/loopback.test.cjs`（6）— 仅绑定回环 + 强 token、无 token/错误 token 一律 403、
CORS 头存在但不替代鉴权、积压回放 + 实时帧 + 序号、未知路径 404 与 `stop()` 释放端口、
无订阅者时广播为无操作。

`tests/helper.test.cjs`（9，集成，真实启动 Shell）— 协议握手版本、在指定目录启动并读回输出、
中文往返（并断言原始字节为 UTF-8）、resize 到达控制台（`mode con` 读数 21×61）、
Ctrl+C 中断长命令后提示符恢复、退出码透传（`exit 7`）、关闭后无残留 Shell、
**强杀辅助进程后整棵 Shell 进程树消失**（Job Object）、未知操作被拒绝。

`tests/main.test.cjs`（6，插件入口，stub 宿主 API）— onLoad 后通道表可用、回环端点与 token 下发、
未知通道被拒、创建标签→执行命令→读回输出→resize→中断→关闭且无残留进程、
重启换新 Shell 且旧 Shell 消失、剪贴板通道读写、标签上限拒绝（`TOO_MANY_TABS`）、
卸载后回环监听消失且 Shell 全部结束。

`tests/vendor.test.cjs`（9）— 钉死 6 个 vendor 文件的 SHA-256；两个脚本各自必须能被当作经典脚本解析、
不含 U+FFFD、不含 CJK 字符（即不是错误代码页重写的产物）；xterm.js 必须保留 UMD 全局导出与
`e.Terminal=d` 赋值；`index.html` 必须先加载 vendor 再加载 `app.js`。

`tests/panel-ui.test.cjs`（9）— 面板结构不变量：`app.js` 里每个 `getElementById` 都必须在
`index.html` 里存在（防止两侧漂移）、单行控制栏与三个图标按钮及其 `aria-label`/`title`、常驻标签栏与
底部状态栏不得回归、会话 / Shell / 更多 / 详情四个弹出层存在且列表可内部滚动、关闭项位于更多菜单
底部且有分隔线、`placePopover()` 存在（弹出层必须被限制在面板内）、渲染器不得引入新依赖。

### 2.3 真实 Shell 手工探针（可复现，输出为证据）

`node tools/helper-probe.cjs cmd interrupt powershell powershell_nobootstrap`：

| 场景 | 观察结果 |
| --- | --- |
| cmd + 中文 | `echo 中文测试` → 输出为 UTF-8 的 `中文测试`；`mode con` 报 100×30 |
| cmd + Ctrl+C | `ping -n 30` 运行中收到 `^C`，提示符恢复，随后 `echo AFTER_INT` 正常 |
| cmd 代码页 | 不修改代码页时 `chcp` 报 936，中文输入输出仍正确（ConPTY 双向 UTF-8） |
| Windows PowerShell 5.1 | 中文正确；`Get-Location` 为项目目录；resize 后 `mode con` 报 21×61；Ctrl+C 有效 |
| 退出 | 关闭后 `exit {"code":0,"forced":false}` |

## 3. 应用内已验证（PI-Desktop 0.17.0 实际进程）

| 项目 | 证据 |
| --- | --- |
| 插件在真实宿主中加载 | `plugin.log`：`plugin.load.success` / `development.plugin.reloaded` |
| 插件进程能启动回环服务 | 日志 `[io.github.hufangyuan460-blip.windows-terminal] loopback: loopback service listening on 127.0.0.1:<port>` |
| Shell 发现与项目目录解析 | 日志 `loaded (helper ok, shells windows-powershell,cmd, cwd <local-path>)` —— 本机只装了 Windows PowerShell 与 cmd，符合预期 |
| 插件可热重载、卸载干净 | 日志 `plugin.unload ok`、`all terminals disposed ... 0 closed` |
| 面板能打开终端并跑真实命令 | 日志：`tab t3 created: windows-powershell -> powershell.exe -NoLogo`、`tab t4 created: cmd -> cmd.exe`（另有 t5），每个标签都记录 helper 与 shell 的 PID；随后检查时这 3 个 helper 与其 shell 进程仍在运行 |

上述日志来自真实应用运行（先是 dev 插件，之后是从 `.piplug` 安装的副本），不是模拟输出。

面板**渲染层**另用浏览器 harness 验证（由 `tools/panel-harness.ps1` 生成：本地页面注入假宿主桥，
用 `Browser` 工具读真实 DOM）：
Shell 可用时**真的创建终端**：`window.Terminal` 必须是函数、必须渲染出 `.xterm` 主机、且没有任何
未捕获错误；快照未到达时显示「正在读取 Shell 列表…」；没有 Shell 时列出探测结果；`state` 失败时
给出「重试」（见 §5 第 8、9 条）。

窄侧边栏布局：`index-widths.html` 把 `ok` 页面放进 280 / 320 / 400 / 600px 的 iframe，
每个框架用 `postMessage` 回报自己的测量值。四个宽度的结果一致：

| 检查 | 结果 |
| --- | --- |
| 页面级横向溢出 | 0 |
| 控制栏 | 单行、高 36px；`＋` / `▾` / `⋯` 都在可视区内且尺寸正常 |
| 超长终端名 | 自动省略（`scrollWidth > clientWidth`），右侧按钮仍完全可用 |
| 多终端 | 连点 `＋` 两次得到 3 个终端：3 个 `.term-host`、3 个已渲染的 xterm、终端列表 3 行且只有 1 行标记为当前 |
| 同名终端区分 | 列表显示 `… #1` / `#2` / `#3` |
| `⋯` 弹出菜单 | 完全落在面板内（含 280px 宽），首项自动获得焦点，`Esc` 关闭且焦点回到 `⋯` |
| 未捕获错误 | 四个框架均为空 |

这**不是**应用内验证：IME、输入回显、选区复制、右键菜单，以及「切换后焦点回到终端」（harness 的
iframe 不持有焦点）都按未验证处理，见第 4 节。

## 4. 未验证（不做声明）

| 项目 | 原因 |
| --- | --- |
| 面板的交互式渲染（xterm 画字、输入回显、IME、选区复制、右键菜单） | 需要人在应用里操作；harness 只能验证结构、文案、下拉与弹出层位置（第 3 节） |
| 切换 / 新建后焦点是否回到终端 | 代码路径已实现（`activate()` 与 `focusTerminal()`），但 harness 的页面跑在不持有焦点的 iframe 里（四个框架都 `document.hasFocus() === false`），无法判定 |
| 面板到插件的宿主桥往返（`state` / `create` / `input` / `read` ...） | 通道逻辑已在 `tests/main.test.cjs` 逐条验证，但**宿主侧 preload 的那一跳**只有在面板打开时才发生 |
| 面板是否能访问回环 SSE（宿主会话级出入站策略 / PNA） | 面板侧会自动降级到轮询并在「终端详情」里显示实际通道；实际走哪条需在面板打开时观察 |
| 跟随宿主的明暗主题与语言切换 | harness 只渲染过暗色 + zh-CN（主题与语言由面板读取宿主参数，亮色 / 英文未渲染） |
| PowerShell 7（`pwsh`） | 本机未安装 |
| Windows 11 / arm64 / 非 936 代码页系统 | 未在目标环境运行 |
| 多文件夹项目的非主根目录、UNC 工作目录 | 未在真实此类项目下运行（逻辑与提示已实现） |

## 5. 自动化过程中发现并修复的真实缺陷

这些不是"顺手改的"，而是本报告的可信度来源：

1. **伪终端属性被静默丢弃**：`STARTUPINFOEX` 非 blittable → `lpAttributeList` 偏移错误。
   症状：`CreateProcess` 成功、Shell 输出跑到插件管道、控制台管道立即 `ERROR_BROKEN_PIPE`。
   修复：指针字段全部用 `IntPtr`；`--selftest` 打印实测布局防回归。
2. **子进程继承父标准句柄**：缺少 `STARTF_USESTDHANDLES` + `INVALID_HANDLE_VALUE`。
   修复后用 `GetConsoleProcessList` 与管道读数双向确认。
3. **控制台侧管道端关闭时机**：必须在 `CreateProcess` 之后关闭。
4. **协议事件缺少 `event` 字段**：`output`/`exit` 事件没有事件名，插件端因此收不到任何输出。
5. **面板拿不到回环端点**：`panelState()` 没有把 `includeTransport` 传给 session 层，
   `state.transport` 恒为 `null` —— 面板会永远退回轮询。由 `tests/main.test.cjs` 暴露。
6. **`chcp 65001` 引导被移除**：实测 ConPTY 双向本来就 UTF-8，切换代码页只会破坏首行回显
   并改变窗口标题。
7. **Windows 上的 libuv 断言**：对端已中止的 SSE socket 再调 `end()`/`destroy()` 会触发
   `!(handle->flags & UV_HANDLE_CLOSING)` 并使插件进程崩溃；已改为仅在 socket 仍可写时 `end()`。

8. **面板把「还没读到状态」当成「没有 Shell」**：空状态文案只在 boot 时（快照到达之前、
   目录仍是默认空值）算过一次，之后 `applySnapshot` 从不重算，于是面板会一直显示
   「未找到可用的 Shell」，即使 Shell 完全可用；`state` 请求失败时同样只剩空状态加一条错误条。
   修复：新增 `ready` / `stateError` 与唯一的 `renderEmptyHint()`（每次状态栏渲染与快照都重算）；
   未就绪时显示「正在读取 Shell 列表…」，失败时显示「无法读取终端状态…」并在错误条上给「重试」；
   真的没有 Shell 时把探测结果写进提示（`已检测到：…；ConPTY 辅助程序：…`）。

9. **打包的 xterm.js 被按错误代码页重写过**：`renderer/vendor/xterm.js` 曾被以 PowerShell 文本模式
   重写（UTF-8 字节按 CP936 解码后再按 UTF-8 写回）。后果：`U+00A0` 变成 `聽`，DEC 字符集表里的
   `◆`/`▒` 变成 `鈼?`/`鈵?`（收尾引号被替换成 `?`），整段脚本**解析失败**。面板因此拿不到
   `window.Terminal`：`新建终端`只报 `window.Terminal is not a constructor`，主区一直停在
   「还没有终端」，重启/清屏按钮也没有反应 —— 而插件进程一侧看起来完全正常（Shell 真的起来了）。
   修复：用 `npm pack @xterm/xterm@5.5.0` 的官方文件按字节重做 vendor（只删掉末尾的 sourceMappingURL
   行），并用上游原文替换了不完整的 `xterm.LICENSE`。防回归：`tests/vendor.test.cjs`（9 项）钉死
   哈希、逐个解析、并拒绝 CJK 字符与替换字符。

## 6. 尚未完成 / 真实阻塞

- **面板人工验证**：需要用户在应用里打开「终端」视图确认一次（渲染、输入、中文、resize、
  复制粘贴、隐藏面板后会话存活）。在此之前，第 4 节内容一律按"未验证"对待。
- **PowerShell 7 真机验证**：本机未安装。
- **应用内自检（`selftest.request`）尚未执行**：该机制已实现（在插件数据目录放入
  `selftest.request` 后重新加载插件，会跑真实 Shell 并写 `selftest-report.json`），
  但本机 `D:\pi` 上宿主的 dev 插件文件监听没有触发重载。标记文件**仍然留在**
  `%USERPROFILE%\.pi-desktop\plugins\data\io.github.hufangyuan460-blip.windows-terminal\selftest.request`：
  下次插件重载时会自动跑一次自检并写出 `selftest-report.json`；不想要就删掉该文件。

> 用户已选择"先不做人工验证、按未验证状态交付"。因此第 4 节内容保持"未验证"，
> 本报告不声称面板在任何环境下可用。

## 7. 构建产物

| 产物 | 大小 | SHA-256 |
| --- | --- | --- |
| `helper/bin/win-x64/pi-conpty-helper.exe` | 10,513,000 | `FAF12F31EA206F138477DF7E0F1E62C4CFF3536EE54DCFBA65A502120B0DEE42` |
| `dist/io.github.hufangyuan460-blip.windows-terminal-1.1.1.piplug`（44 个文件） | 约 11.1 MB（随文档更新微变） | 不内嵌（自引用）：打包后用 `Get-FileHash dist\*.piplug -Algorithm SHA256` 核对 |

`PluginCheck`：通过（44 个文件），1 条预期警告 —— `net.domains` 声明了 `127.0.0.1`。
原因见 [ARCHITECTURE.md §2](ARCHITECTURE.md)：面板需要访问插件自己的回环事件流，
而插件未申请 `net.fetch`。

### 重新生成

```powershell
powershell -ExecutionPolicy Bypass -File tools/build-helper.ps1 -Force   # 重建辅助程序
powershell -ExecutionPolicy Bypass -File tools/run-tests.ps1             # 全量验证
# 然后用 PluginCheck / PluginPack 校验并打包（或经由宿主提供的插件工具链）
```

- **arm64 构建**：未提供发布配置。
