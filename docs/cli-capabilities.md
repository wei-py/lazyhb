# HBuilderX CLI 能力与 TUI 需求对照

调查日期：2026-10-26。依据官方在线文档及本机 HBuilderX 5.24.2026081301 的只读 CLI 输出。文档声明支持不等于本机已完成运行、打包验证。

## 结论

CLI 可作为 TUI 的主要执行后端，已经覆盖大量运行、编译、发行、日志和云开发能力，但不是 HBuilderX 全部界面的等价 API。仅包装 CLI 不能据此承诺全部项目右键操作、全部 manifest 配置交互及三端完全无 GUI 运行。

完整目标保留；用户后续已批准先实现可落地部分，暂缓已识别缺口。当前实现与验证边界见 [README](../README.md)，本文件其余内容保留为原始能力调查记录。

2026-10-28 增补：[运行发行与产物矩阵](run-publish-workflows.md)重新逐页核对官方运行、资源、WGT、云打包、鸿蒙和 Web／小程序发行文档，并读取本机 5.24 的 `--help`。包含条件参数、重复固定 type 帮助段、设备平台、配置文件、产物差异和文档与本机冲突；没有执行真实运行／发行。下面的 2026-10-26 实测记录继续保留，不扩大为新版本或真实平台成功证明。

本轮停止语义补充见[停止与生命周期](run-publish-workflows.md#停止与生命周期)：本地 CLI／监听取消不等于关闭设备 App 或取消远端云包。所查官方文档与本机 help 未提供通用设备运行停止接口；不扩大为对所有版本的断言。

### 当前任务入口

工作台的项目上下文（项目列表 `o`／右键）、`r` 运行／编译、`Shift+R` 发行／打包使用当前 `--help` 的实际命令与参数枚举；`t` 保留高级 CLI。分类模块不替代 `HXClient.arguments` 的最终安全检查，不固定某版本的命令数量。

`r`／`Shift+R`／`f` 在项目列表焦点使用高亮项目，在主区使用已加载项目；`o`／右键菜单固定捕获目标，不随之后的选择变化漂移。

- `launch` 必须可接受 `ui=false` 或 `ui=0`。Web、普通小程序与快应用还须可接受 `compile=true`，只显示「仅编译」。App 与鸿蒙元服务只有可用的设备运行模式才称运行；App 仅支持编译时同样标明仅编译。iOS 模拟器不开放，未知非既有 launch 家族不推测运行能力。
- 仅编译入口要求最终显式 `compile=true`；表单清空或改为其它值时拒绝继续，不把无参数的 CLI 隐式行为标成仅编译。
- 发行入口按实际 `publish <target>` 的产物／模式区分本地资源、WGT、Web 构建／托管、小程序资源／上传，以及 `pack`、`pack app-harmony`、`pack mp-harmony`。`pack status/cancel` 是绑定目标项目的打包管理，不是创建收费云包；官方未定义远端任务 ID 参数。cloud／hosting 等不混入运行发行清单。
- 项目任务仅识别 `project`／`projectPath`／`prj` 为当前命令实际暴露的选择器；`path` 可能是产物目录。缺少明确选择器时反馈不能绑定项目，不执行 IDE 隐式当前项目。`pack --config` 必须单独处理配置内项目绑定，不追加命令行 project 参数。
- 界面操作按项目／配置／资源／工具分组，列出操作、快捷键与说明；字段按字段、当前值与类型对齐。`[`／`]` 切换当前焦点组的页签。

## 能力清单

| 能力 | 已确认命令或文档 | 对需求的边界 |
| --- | --- | --- |
| 列出、导入、关闭项目 | `project list/open/close`，见[项目文档](https://hx.dcloud.net.cn/cli/project) | 文档未定义与 GUI“移除项目”相同的独立 remove 命令，不能用 close 冒充 remove |
| 新建项目 | 本机 `cli --help` 有 `project create --name --path --type` | 类型枚举为 uni-app、uni-app-x、app-plus、wap2app、web、ideExtension；未实测创建 |
| 账号 | `user info/login/logout`，见[账号文档](https://hx.dcloud.net.cn/cli/user) | CLI 支持账号登录，不代表购买、申请密钥、授权流程均已终端化 |
| IDE 设置 | `config get/set --key`，见[配置文档](https://hx.dcloud.net.cn/cli/config) | 5.21+；编辑器字体、Gradle 路径等 HBuilderX 设置，不是项目 manifest 配置 API |
| Android、iOS、鸿蒙运行 | `launch app-android/app-ios/app-harmony`，见[App 运行文档](https://hx.dcloud.net.cn/cli/launch-app) | 设备选择、仅编译、缓存、页面参数、自定义基座等；具体参数因平台不同，自定义基座仅支持云打包基座 |
| Web/H5 运行 | `launch web`，见[Web 运行文档](https://hx.dcloud.net.cn/cli/launch-web) | 有浏览器选择及 `--compile true`；仅编译不是浏览器实际运行 |
| 小程序及快应用运行 | `launch mp-*`，见[小程序运行文档](https://hx.dcloud.net.cn/cli/launch-miniProgram) | 文档及本机帮助包含微信、支付宝、百度、抖音、QQ、360、快手、飞书、京东、小红书、鸿蒙元服务、华为快应用、联盟快应用；uni-app x 的小程序目前仅微信 |
| Android/iOS 云打包 | `pack`、`pack status`、`pack cancel`，见[云打包文档](https://hx.dcloud.net.cn/cli/pack) | 支持证书、平台、自定义基座、安心打包等参数；status 5.11+，cancel 5.14+；需要先启动 HBuilderX |
| App 本地打包资源 | `publish app-android/app-ios --type appResource`，见[资源文档](https://hx.dcloud.net.cn/cli/publish-app-appResource) | 生成资源，不等于本地生成最终 APK/IPA；后续原生构建需要对应工具链 |
| WGT | `publish ... --type wgt`，见[WGT 文档](https://hx.dcloud.net.cn/cli/publish-app-wgt) | 有名称、路径、混淆等参数，适用平台需按项目类型核实 |
| 鸿蒙本地打包 | `pack app-harmony`、`publish app-harmony --type appResource`，见[打包](https://hx.dcloud.net.cn/cli/pack-app-harmony)、[资源](https://hx.dcloud.net.cn/cli/publish-app-harmony) | 需要 HBuilderX 运行及鸿蒙构建环境 |
| 鸿蒙元服务打包 | `pack mp-harmony`，见[元服务文档](https://hx.dcloud.net.cn/cli/pack-mp-harmony) | 仅 uni-app |
| Web 发行 | `publish web`，见[Web 发行文档](https://hx.dcloud.net.cn/cli/publish-h5) | 编译、SSR、uniCloud 前端网页托管等 |
| 小程序发行及上传 | `publish mp-weixin/mp-alipay`，见[小程序发行文档](https://hx.dcloud.net.cn/cli/publish-miniProgram) | 文档明确给出微信、支付宝及 CI 上传，持有上传密钥后可无需开发者工具上传；其他运行目标不能据此算作发行已验证 |
| 日志与设备 | `logcat ...`、`devices list`，见[App 日志](https://hx.dcloud.net.cn/cli/logcat-app)、[Web 日志](https://hx.dcloud.net.cn/cli/logcat-web)、[小程序日志](https://hx.dcloud.net.cn/cli/logcat-miniProgram)、[设备](https://hx.dcloud.net.cn/cli/devices-list) | 可用于终端日志与目标设备选择；不据此承诺完整调试器及全部停止/重启操作 |
| 截图 | `screencap ...`，见[截图文档](https://hx.dcloud.net.cn/cli/screencap-app) | 提供 App/Web 截图命令，不等于把应用图形界面搬进 TUI |
| UTS 编译 | `compile app-android/app-ios`，见[UTS 文档](https://hx.dcloud.net.cn/cli/compile-uts) | 5.21+，单文件或单 uni_modules 模块 |
| uniCloud | `cloud functions`，见[云开发文档](https://hx.dcloud.net.cn/cli/uniCloud) | 列举、上传、下载资源、初始化数据库、绑定空间；本机帮助还列出支付宝云环境及资源创建/运行，不据此推断所有服务商行为相同 |
| 前端托管 | `hosting deploy/list/delete`，见[托管文档](https://hx.dcloud.net.cn/cli/uniCloud-hosting) | 需要登录并预先开通服务 |
| uni_modules 插件 | `uni_modules --download/--upgrade/--list`，见[模块文档](https://hx.dcloud.net.cn/cli/uniModules) | 5.0+；在线文档还列出 5.31+ 新建、发布、资料、依赖和校验，本机 5.24 未列出这些新操作 |
| uni-agent | 本机帮助有 `uni-agent --prompt --project --continue --output-format stream` | 已有终端对话入口；未验证与右键“添加文件/文件夹到聊天”的上下文语义等价 |
| 语言服务 | 本机帮助有 `lsp hover/references/goToDefined/lint/...` | CLI 还有语言服务能力；不自动解决项目索引管理菜单的缺口 |

## 全配置不是 config 命令

[manifest 官方文档](https://uniapp.dcloud.net.cn/collocation/manifest.html)说明：应用名称、图标、权限等属于 manifest.json，HBuilderX 项目放在根目录，CLI 工程放在 src 目录。

[INFERENCE] TUI 可以自行实现各配置分类的表单，直接读写项目配置，再调用 CLI 编译发行。这是额外产品实现，不是现成 CLI 配置界面。全字段覆盖、图片资源生成、原生插件选择、账号授权等操作必须分别验证；可写 JSON 不等于复刻了所有配置操作。

`uni_modules` 管理的是 uni_modules 模块，不能将其下载命令当成 manifest“安卓/iOS 原生插件配置”中本地及云端原生插件选择的完整替代。当前查阅的 CLI 文档及本机帮助未见该选择流程的等价命令。

已补充[全部 22 个配置入口的逐类审计](manifest-config-audit.md)，包含图标生成及替换、启动图/storyboard、模块/SDK、权限、平台配套文件、鸿蒙取证和统计后台等；不是只检查原生插件。配置字段可写、配套文件可生成、远程服务可开通是三个不同的验收对象。

## 项目右键菜单缺口

当前查阅的 CLI 文档及本机帮助未见完整对应命令：修改项目别名、独立移除项目、重识别项目类型、重建项目索引、HBuilderX 本地历史、完整 GitCode 托管流程，以及部分新建页面/模板与项目属性交互。

[INFERENCE] 文件创建、复制、移动、重命名、搜索、刷新及折叠等可以由 TUI 自己实现。但需要另行保证与 HBuilderX 元数据的语义一致；不应将文件系统重命名当作“修改项目别名”。“在新窗体中打开”“打开所在目录”等 GUI 行为与严格禁止外部 GUI 的要求存在语义冲突，需要设计终端等价操作而不是假装 CLI 已覆盖。

## 不打开 GUI 的边界

1. [App 运行文档](https://hx.dcloud.net.cn/cli/launch-app)明确：5.11+，不传 `--ui` 或 `--ui false` 为纯 CLI 运行，在终端完成编译与运行；`--ui true` 才交由 IDE 界面接管。
2. 这证明不用 IDE 运行面板交互，但不能证明 macOS/Windows 上从零启动后没有 HBuilderX 窗口。[总览](https://hx.dcloud.net.cn/cli/README)、[配置](https://hx.dcloud.net.cn/cli/config)、[云打包](https://hx.dcloud.net.cn/cli/pack)等明确要求 HBuilderX 先运行。本机 CLI 二进制也含“未检测到 HBuilderX 运行，请执行 cli open”错误文本。
3. [Linux 总览](https://hx.dcloud.net.cn/cli/README#linux-cli)明确提供没有可视化编辑器的 Linux CLI，面向服务器自动化；官方仅在 Ubuntu 测试。[Linux 工作流](https://hx.dcloud.net.cn/cli/linux-uts-workflow)仍需要 `cli open` 启动后台，再执行命令，不代表需要 GUI。
4. [Web 运行文档](https://hx.dcloud.net.cn/cli/launch-web)有实际浏览器运行与仅编译两种模式。若连目标浏览器、模拟器、开发者工具的显示也禁止，不能用 `--compile true` 冒充完整运行或可视调试。
5. macOS/Windows 冷启动无窗口、本地工具链的宿主限制、小程序实际运行所需工具及其无 GUI 能力，本次未端到端验证，因此不能承诺三端所有目标都无 GUI。

## 本机实测及未做的验证

执行前通过进程列表观察到 HBuilderX 主进程已经运行；未由本次调查启动或退出用户的 HBuilderX。

- `/Applications/HBuilderX.app/Contents/MacOS/cli ver` 返回 `5.24.2026081301`。
- `cli --help` 成功列出上述本机命令，包括 launch 的 `--ui`（默认 false）与 `--compile`。
- `cli project list` 成功列出 10 个项目，最后输出 `0:project list:OK`；其中包含同名项目，因此集成时应优先使用项目绝对路径，而非仅依赖显示名称。
- 未改动项目、登录态或设置，未上传资源、发起付费云打包、运行用户项目、打开目标浏览器或退出 IDE。
- 未验证 Windows、Linux 实机，也未完成 macOS 关闭 IDE 后的冷启动无 GUI 场景。

## 实现方向（建议，尚非用户确认的架构决定）

以官方 CLI 为执行后端；TUI 自己提供项目管理交互、manifest 全配置表单、资源生成、任务及日志界面。不能把整套需求理解为给 CLI 菜单套壳。先解决桌面平台无窗口冷启动、剩余发行平台、各配置分类中的资源/证书/SDK 服务/原生插件授权，以及 IDE 专有项目操作的接口缺口，再对“功能完全对齐且全程无 GUI”作交付承诺。详细分类见[全配置审计](manifest-config-audit.md)。
