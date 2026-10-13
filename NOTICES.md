# Third-party notices

本应用分发包中捆绑或链接了以下第三方组件，在此附上其许可证声明。除特别说明外，依赖均以 `package.json` / `pnpm-lock.yaml` 声明的版本为准。

## FFmpeg（ffmpeg-static）

- 组件：`ffmpeg-static` 预编译 FFmpeg 二进制，随安装包分发。
- 许可证：**GPL-3.0-or-later**（该二进制以 `--enable-gpl` 配置构建）。
- 源码获取：FFmpeg 源码见 <https://ffmpeg.org/download.html>；`ffmpeg-static` 打包源码见 <https://github.com/eugeneware/ffmpeg-static>。
- 许可证全文见 <https://www.gnu.org/licenses/gpl-3.0.html>。本应用以独立进程方式调用 FFmpeg；如需重新分发本应用，请一并保留本声明与上述源码获取途径。

## libvips（sharp 的预编译原生依赖）

- 组件：`@img/sharp-libvips-*` 预编译动态库，随安装包分发。
- 许可证：**LGPL-3.0-or-later**。
- 源码获取：<https://github.com/libvips/libvips>；许可证全文见 <https://www.gnu.org/licenses/lgpl-3.0.html>。

## elkjs

- 许可证：**EPL-2.0**。源码：<https://github.com/kieler/elkjs>；许可证全文见 <https://www.eclipse.org/legal/epl-2.0/>。

## 双许可证依赖的选用声明

- `jszip`：**MIT OR GPL-3.0-or-later**，本项目选用 MIT 分支。
- `dompurify`：**MPL-2.0 OR Apache-2.0**，本项目选用 Apache-2.0 分支。

## 字体

- Inter、JetBrains Mono（经 `@fontsource-variable/inter`、`@fontsource-variable/jetbrains-mono` 引入）：**SIL Open Font License 1.1**，允许随软件再分发。许可证全文见 <https://openfontlicense.org/>。

## 厂商标识图标

- `apps/editor/public/providers/` 下的厂商图标来源与许可记录见同目录 `SOURCES.md`（主体为 Simple Icons / gilbarbara-logos，CC0-1.0；少数为厂商官网 favicon 的指示性使用）。

## 其他依赖

其余依赖为 MIT / Apache-2.0 / ISC / BSD 等宽松许可证，各自许可证文本可在对应包的发行物或源码仓库获取。
