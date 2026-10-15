# 第三方资源与声明

本插件随包分发的第三方内容只有前端终端库；ConPTY 辅助程序是自研代码，
只依赖 .NET 8 的框架程序集（随自包含发布一起打进 `pi-conpty-helper.exe`）。

## 1. xterm.js

- 包：`@xterm/xterm` 5.5.0
- 文件：`renderer/vendor/xterm.js`、`renderer/vendor/xterm.css`、`renderer/vendor/xterm.LICENSE`
- 许可证：MIT（见 `xterm.LICENSE`，文件内保留原版权声明）
- 获取方式：`npm pack @xterm/xterm@5.5.0`，取包内 `lib/xterm.js`、`css/xterm.css` 与 `LICENSE`。
  分发的 `xterm.js` **只**删掉末尾一行 `//# sourceMappingURL=xterm.js.map`（没有随包分发 `.map`），
  其余字节与上游一致；`xterm.css` 与 `xterm.LICENSE` 是上游原文。不修改代码逻辑。
- SHA-256（上游 → 分发）：
  - `lib/xterm.js` `1F991AC3B4B283EBF96E60AE23A00A52765DD3A2E46FA6FDDA9F1AAB032F7495` →
    `renderer/vendor/xterm.js` `7A88E46A58847D3F17109E3D48CC8AA056A01997D00CEB76035F63370712D858`
  - `css/xterm.css` `BA8E6985669488981CCF40C0CEFE3ABA80722CB6C92DE7AD628B0BD717FAF2B6` =
    `renderer/vendor/xterm.css`（未改）
  - `LICENSE` `B569F629D00F2626A8100DF2A1798210535621E42164DFD426A6FE5AAC7B0CCD` =
    `renderer/vendor/xterm.LICENSE`（未改）
- 上游：https://github.com/xtermjs/xterm.js

## 2. @xterm/addon-fit

- 包：`@xterm/addon-fit` 0.10.0
- 文件：`renderer/vendor/addon-fit.js`、`renderer/vendor/addon-fit.LICENSE`、
  `renderer/vendor/addon-fit.package.json`（保留版本来源信息）
- 许可证：MIT（见 `addon-fit.LICENSE`）
- 获取方式：`npm pack @xterm/addon-fit@0.10.0`，取包内 `lib/addon-fit.js`（同样只删掉末尾的 sourceMappingURL
  行）、`LICENSE` 与 `package.json`。
- SHA-256（上游 → 分发）：`lib/addon-fit.js`
  `BDAEFA370B1BFC42EE88D46FE6072400902A4D4B2D45CD93438DDA9B23C97089` →
  `renderer/vendor/addon-fit.js` `3E9AE6F6965EE1269D5574B905CF1BF559C2F44C784255B0034A71387E7719C9`；
  `LICENSE` `E256F01188AF527E4D06D21D06FBF785AE9C50D4B328BF03CBE0BA7F0AA4228F` =
  `renderer/vendor/addon-fit.LICENSE`（未改）；`package.json`
  `5A70FC5520AB1B7B4C4D9E527ACC78395E99A8AA539DE583C930F5671DBCC044` =
  `renderer/vendor/addon-fit.package.json`（未改）。
- 上游：https://github.com/xtermjs/xterm.js

## 3. .NET 运行时（辅助程序内）

`helper/bin/win-x64/pi-conpty-helper.exe` 是用 `dotnet publish -r win-x64 --self-contained`
发布的自包含单文件程序，其中包含 .NET 8 运行时与 .NET 基础类库的二进制片段。

- 许可证：MIT（.NET Foundation，见 https://github.com/dotnet/runtime/blob/main/LICENSE.TXT）
- 未使用任何第三方 NuGet 包，因此没有额外的传递依赖声明。
- 发布参数：`PublishSingleFile` + `PublishTrimmed` + `IncludeNativeLibrariesForSelfExtract`
  + `EnableCompressionInSingleFile`（见 `helper/PiConptyHelper.csproj` 与 `tools/build-helper.ps1`）。

## 4. 与第三方插件的参考关系

需求调研阶段静态阅读过第三方插件
[WnJee/pi-desktop-plugin-terminal](https://github.com/WnJee/pi-desktop-plugin-terminal)
的架构（xterm.js 前端 + 回环事件流）。本插件**没有复用其代码**：前端、协议、后端辅助程序
均为本仓库自写，插件 ID 也独立（`io.github.hufangyuan460-blip.windows-terminal`），与其无命名冲突。
