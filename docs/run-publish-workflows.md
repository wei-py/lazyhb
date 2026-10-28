# 运行、发行与产物：官方事实矩阵

调查日期：2026-10-28。网页经 BrowserOS neo 实际打开；本机仅执行 `/Applications/HBuilderX.app/Contents/MacOS/cli --help`，返回 HBuilderX `5.24.2026081301`。没有运行用户项目、启动 IDE/目标浏览器/开发者工具、登录、上传或发起云打包。本文是文档和能力调查，不是实际发行成功证明；[原调查](cli-capabilities.md)的 2026-10-26 验证记录仍独立保留。

## 已确认的安全边界

[App 运行文档](https://hx.dcloud.net.cn/cli/launch-app)原文：不传 `--ui` 或 `--ui false` 为“纯 CLI 运行：在终端完成编译与运行”；`--ui true` 为“由 IDE 界面接管后续流程”（5.11+）。**ui 控制 IDE 接管，不是禁止目标浏览器/模拟器/开发者工具的开关。**

lazyhb 已确认不打开外部 GUI，不能擅自改成可选 GUI 启动。App 真机、鸿蒙元服务设备运行与仅编译应分开；Web/普通小程序/快应用仅编译不能宣称完整运行。iOS 图形模拟器、IDE 接管及需要外部 GUI 的目标运行应解释限制，而非伪造无 GUI 支持。

[总览](https://hx.dcloud.net.cn/cli/README)明确“查看帮助文档，需要先启动 HBuilderX”；云打包和鸿蒙打包也有此前置。终端控制不证明 macOS/Windows 冷启动无窗口。Linux CLI 原文“不是 HBuilderX 可视化编辑器”，官方仅在 Ubuntu 测试，不代表三平台全部工具链已验证。

## 项目选择器不能混用

- 本轮读取的 `launch`、`publish`、`pack` 使用 `project`；launch 文档为“HBuilder X 里导入的项目名称或绝对路径”，本机 publish 多为“已导入项目的绝对路径”。应绑定绝对路径，避免同名项目歧义。
- 本机 `projectPath` 用于 LSP 项目根路径；`prj` 的云操作帮助为“项目名称或项目在列表中的编号”。它们是当前命令确实声明时才可使用的键，不能宣称每个运行命令都支持别名。
- `path` 随命令改变语义：`project open/close` 是项目绝对路径，WGT 是**导出目录**，hosting 是云端路径。不能把所有 `path` 自动填为当前项目。
- [pack 配置文档](https://hx.dcloud.net.cn/cli/pack?id=config)原文：“使用 `--config` 打包时，所有参数在 JSON 中配置，不要与 `--project`、`--platform` 等命令行参数混用。”配置入口必须检查配置内项目，不能自动追加 `--project`。

## 运行矩阵

各行参数仅在当前 CLI help 暴露时可提交。文档默认值不是要求 TUI 为所有版本强行注入同一参数。

| 命令目标 | 官方参数事实 | 真正运行、产物与限制 |
| --- | --- | --- |
| `launch app-android` | [App](https://hx.dcloud.net.cn/cli/launch-app)：`ui`、`compile`、`native-log`、`cleanCache`、`continue-on-error` 均 true/false，默认 false；`deviceId` 默认首设备；`playground` standard/custom 默认 standard；`pagePath/pageQuery` 5.01+ | 真机运行与 `compile=true` 仅编译分开。自定义基座原文“仅支持云打包基座”；cleanCache 仅 uni-app x 生效 |
| `launch app-ios` | [App](https://hx.dcloud.net.cn/cli/launch-app)：`iosTarget` device/simulator 默认 device；设备、基座、compile 同上；`peveloperCertificate`、`provisioningProfile`、`privateKey` 原文“开发 uts 插件需要” | 保留官方 `peveloperCertificate` 拼写，不擅改；模拟器受 noGUI 限制。privateKey 是密码，当前非 pack argv 凭据安全策略另有限制，不等于有字段就能安全执行 |
| `launch app-harmony` | [App](https://hx.dcloud.net.cn/cli/launch-app)：`deviceId`、cleanCache、compile、continue-on-error、pagePath/pageQuery；未列 playground | 设备运行或仅编译；需要鸿蒙工具链和真机签名 |
| `launch web` | [Web](https://hx.dcloud.net.cn/cli/launch-web)：compile 默认 false；browser 为 Built/Chrome/Firefox/Ie/Edge/Safari，默认 Built；continue-on-error 默认 false | 官方有真实浏览器运行，但本项目只允许显式 compile=true；编译成功不证明浏览器已运行 |
| `launch mp-weixin/mp-alipay/mp-baidu/mp-toutiao` | [小程序](https://hx.dcloud.net.cn/cli/launch-miniProgram)：project、ui、compile、continue-on-error、runtime-log；布尔默认 false | uni-app x 仅微信；其余 classic。当前仅编译；runtime-log 不是启动目标工具的免 GUI 许可 |
| `launch mp-qq/mp-360/mp-jd/mp-kuaishou/mp-lark/mp-xhs` | [小程序](https://hx.dcloud.net.cn/cli/launch-miniProgram)：project、ui、compile、continue-on-error | 仅 classic；当前仅编译，不能从有 launch 推断有同名 publish |
| `launch mp-harmony` | [小程序](https://hx.dcloud.net.cn/cli/launch-miniProgram)：仅 classic；deviceId 默认首设备，cleanCache/compile/continue-on-error 默认 false | 鸿蒙元服务设备运行，与普通小程序开发者工具运行不同；允许已准备工具链的设备运行及仅编译 |
| `launch quickapp-webview-huawei/quickapp-webview-union` | [小程序](https://hx.dcloud.net.cn/cli/launch-miniProgram)：仅 classic；project、ui、compile、continue-on-error | 当前仅编译，不能称完整快应用运行 |

[设备文档](https://hx.dcloud.net.cn/cli/devices-list)参数表：`devices list --platform` 为 `android`、`ios-iPhone`、`ios-simulator`、`mp-harmony`、`app-harmony`，默认 android。设备查询平台不全等于 launch target；应按当前 help 枚举查询，不猜设备 ID。查询列表不等于自动启动模拟器。

## 发行矩阵：资源不是安装包

| 命令/模式 | 项目、参数和官方原文 | 产物/副作用 |
| --- | --- | --- |
| `pack` Android/iOS 云打包 | [云打包](https://hx.dcloud.net.cn/cli/pack)：classic/x；platform 默认 android，可 android、ios 或英文逗号多个平台；项目已导入；详细条件见下节 | 原生安装包（Android/iOS），不是 appResource/WGT；云操作可能收费。原文“传统打包会输出下载地址，安心打包会输出打包成功后的路径” |
| `publish app-android/app-ios --type appResource` | [本地资源](https://hx.dcloud.net.cn/cli/publish-app-appResource)：classic/x，另支持 Wap2App/5+App；type/project 必填；4.67-alpha+ 平台拆分 | “生成本地打包 App 资源”，不是最终 APK/IPA，后续原生工具链构建仍必要 |
| `publish app-android/app-ios --type wgt` | [WGT](https://hx.dcloud.net.cn/cli/publish-app-wgt)：classic/x；type/project 必填；name 默认 AppID.wgt，path 默认项目根目录/unpackage/release；confuse 默认 false | WGT 更新资源包，不是安装包。文档称 name 默认 AppID.wgt，本机 help 仅称 AppID；不要自己重新实现后缀规则 |
| `publish app-harmony --type appResource/wgt` | [鸿蒙资源](https://hx.dcloud.net.cn/cli/publish-app-harmony)明确 classic/x，type 必填且“appResource 或 wgt” | 鸿蒙工程/资源或 WGT，不能冒充已签名安装包 |
| `pack app-harmony` | [鸿蒙打包](https://hx.dcloud.net.cn/cli/pack-app-harmony)：classic/x，project 必填；先有 HBuilderX 和工具链 | [鸿蒙运行发行指南](https://uniapp.dcloud.net.cn/tutorial/harmony/runbuild.html#signing-release)明确发布签名后得到 `.app` 安装包；`.hap` 是运行包/内部测试分发场景，不应把此入口一律标为 HAP |
| `pack mp-harmony` | [元服务打包](https://hx.dcloud.net.cn/cli/pack-mp-harmony)：仅 classic；project 必填；本地打包 | 元服务打包，与 App、普通小程序源码发行不同；CLI 页没有额外证书参数，不能猜造 |
| `publish web` 本地构建 | [Web 发行](https://hx.dcloud.net.cn/cli/publish-h5)：classic/x；webHosting 默认 false，ssr 默认 false；webTitle 默认项目名，webDomain 可选 | 生产 Web 编译结果，不等于已上线网站；不要虚构 `--onlycompile` |
| `publish web --webHosting true` | [Web 发行](https://hx.dcloud.net.cn/cli/publish-h5)：provider aliyun/alipay/tcb，spaceId；ssr 仅 Vue3；ssrHost 在多域名时需要，ssrProvider 在多服务商时需要 | 上传 uniCloud 托管；原文“云端已存在此文件，会使用本地文件覆盖”。不是本地编译模式的别名 |
| `publish mp-weixin` | [小程序发行](https://hx.dcloud.net.cn/cli/publish-miniProgram)：classic/x；upload 仅 true 生效；上传时 appid 必填和 privatekey 上传密钥；version 可省略读取 manifest；robot 1–30 默认 1；sourceMap 默认 false | 默认编译小程序资源；upload=true 才 CI 上传，不等于审核/上架。微信 CI 插件和开启时的 IP 白名单是前置 |
| `publish mp-alipay` | [小程序发行](https://hx.dcloud.net.cn/cli/publish-miniProgram)：仅 classic；upload=true 上传，privatekey 为支付宝开发工具密钥；version 可省略读取 manifest | 默认资源编译与上传分开。文档 appid 表写必填但仅编译示例省略；本机 help 未标必填，不能未经核实将其无条件强制 |
| `pack status` / `pack cancel` | [打包管理](https://hx.dcloud.net.cn/cli/pack)：status 5.11+、cancel 5.14+；project；cancel platform 一次单个 app-ios 或 app-android | 查询/取消远端云打包，不创建新包。文档和本机 help **没有 task ID 参数**；本地进程 ID/任务编号不能冒充云端任务 ID。停止本地进程不保证取消远端包 |

其他 mp 目标不能仅凭运行目标名单承诺支持发行；必须发现对应 publish 命令。本机此次 publish 小程序仅微信、支付宝。

## 停止与生命周期

2026-10-28 通过 BrowserOS neo 复核 [App 运行](https://hx.dcloud.net.cn/cli/launch-app)、[Web 运行](https://hx.dcloud.net.cn/cli/launch-web)、[小程序运行](https://hx.dcloud.net.cn/cli/launch-miniProgram)、[总览](https://hx.dcloud.net.cn/cli/README)、[App 日志](https://hx.dcloud.net.cn/cli/logcat-app)、[Web 日志](https://hx.dcloud.net.cn/cli/logcat-web)、[小程序日志](https://hx.dcloud.net.cn/cli/logcat-miniProgram)和 [pack](https://hx.dcloud.net.cn/cli/pack)，并复用已保存的本机 `5.24.2026081301 --help` 完整输出，没有为核查重复运行真实目标。

- **本地任务停止不等于停止设备 App。** 所查文档与本机 help 未提供通用 `launch stop` 或关闭目标设备 App 的接口，也未提供“中断 launch 进程后保证设备 App 关闭”的承诺。不能编造 stop／kill 参数，不能把停止日志监听表述为设备已停止。
- **Ctrl+C 的边界。** 所查 launch／logcat 页面未明确规定 Ctrl+C 的设备生命周期语义。终端中断当前 CLI／日志监听，不能据此推断设备应用、HBuilderX 托管的运行任务或远端任务均已结束；lazyhb 中 `Ctrl+C` 是退出工作台并按需提示，`Ctrl+K` 才是停止当前本地任务。
- **不要用退出 IDE 代替停止任务。** 总览和本机 help 的 `cli app quit` 原文为“关闭HBuilderX”，不是目标 App 停止接口；lazyhb 不会为取消一个任务关闭用户 IDE，也不改变 [noGUI 合同](doc.md)。
- **云打包取消是独立远端操作。** pack 文档原文“取消 App 云打包任务”，5.14+ 的 `pack cancel` 使用 `project` 与一次一个 `app-ios`／`app-android` 平台；本机 help 同样列出这些参数，未提供远端 task ID。停止本地 pack／logcat 进程不能宣称云包已取消；应另行明确提交取消并查询 `pack status`，没有结果时保留“远端状态未确认”。
- **工作台操作合同。** 顶部停止按钮、`Ctrl+K` 和工具组停止操作取消本地任务／连接／候选 CLI 验证；重复停止不重复启动取消流程，停止中等待本地进程树退出，之后可继续工作。取消候选验证不保存候选、不替换旧连接。忙时允许只读导航，拒绝冲突任务、写操作及项目切换但不向任务输出反复追加同一句阻塞消息。此为 lazyhb 的本地行为，不是官方 CLI 的设备关闭保证。

以上为所查版本和页面的证据范围，不断言所有 CLI 版本永远没有其它停止能力；也未通过真实设备、用户项目或云任务实测中断后的生命周期。

## 云打包条件字段

以下均来自 [pack 参数表及示例](https://hx.dcloud.net.cn/cli/pack)，本机 5.24 help 同时包含其语义；不是 blanket 必填清单。

- Android：`android.packagename` 原文“打包 Android 时必填”。`android.androidpacktype` 默认 0，自有证书；1 公共证书；2 DCloud 老版证书、3 云端证书仅 classic。自有证书时填 `android.certalias/certfile/certpassword/storepassword`。
- iOS：`ios.bundle` 原文“打包 iOS 时必填”。`ios.profile/certfile/certpassword` 为自定义证书资料；不能忽略官方自定义基座示例没有这三项而一律强制。supporteddevice 默认 iPhone，可 iPhone/iPad 英文逗号多值；channels phone/simulator 仅 macOS。
- iscustom=true 为自定义基座；safemode=true 安心打包仅 classic；sourceMap 默认 false。dsyms、isconfusion、rpads、ad.content、Android 防重签标为仅 classic，不能把 x 表单装成全部生效。
- dsyms、ad.domestic/international/content、ignoreWarnings、三个 antiResign 项为 5.14+。广告、渠道、设备名单某些字段允许逗号多值，不应当作单值枚举。
- config 是 UTF-8 JSON：project/platform 在顶层；android/ios/ad 使用嵌套对象。官方 JSON 示例 `storePassword` 与 CLI `android.storepassword` 大小写不同，不应擅自把任意点号参数当成完全等价 JSON 键。

## 鸿蒙前置不是 CLI 参数

从 uni-app 官网链接跟到[运行和发行指南](https://uniapp.dcloud.net.cn/tutorial/harmony/runbuild.html)：classic 鸿蒙仅 Vue3；HBuilderX 4.81+ 要求 DevEco Studio 5.1.0.849+；真机必须配置签名资料，发布需发布证书，否则“未签名的安装包，是无法实际使用的”。签名最终在鸿蒙工程 `build-profile.json5` 生效，兼容 `harmony-configs/build-profile.json5`；不能把 GUI 申请证书过程宣称已 CLI 化。

默认工程路径分别 `unpackage/dist/dev/app-harmony`、`unpackage/dist/build/app-harmony`，可用 `.hbuilderx/launch.json` distPathDev/distPathBuild 修改。工具链对路径字符/长度有限制，不应只校验项目存在就承诺构建可用。启动鸿蒙模拟器原文“只能在 DevEco Studio 中完成”；本轮不启动。

## 当前 help 与在线文档的差异

1. 本机 5.24 同一个 `publish app`、`publish app-android`、`publish app-ios`、`publish app-harmony` 各出现多个同名段：资源段 type 描述“固定为 appResource”，WGT 段“固定为 wgt”；Harmony 首段还有“可选值：appResource、wgt”。不是所有 enum 都使用 `取值有[...]`。解析不能后一段覆盖前段，界面也不能只按 command.name 区分产物。
2. 本机 `pack platform`、`android.androidpacktype` 以中文描述给默认/选项，而不是结构化枚举；不要在泛化 parser 里把“打包 Android 时必填”误读成所有平台都必填。
3. 本机没有 `onlycompile`。launch 的仅编译是 `compile=true`；publish 的本地构建是关闭对应 upload/webHosting，而非复用 launch 参数。
4. 本机微信/支付宝明确“subPackage 和 upload 只能填写其中一个”；在线文档却有两者组合示例。执行以当前 CLI 约束为准，上传和混合分包不混用；关闭上传的本地模式也无需注入多余 upload 字段造成歧义。
5. 本机 WGT/ Web help 含 sourceMap，部分对应在线参数表未列；本机有才可暴露。`uni_modules` 在线 5.31+ 能力不能因文档存在就当作本机 5.24 支持。
6. `--help` 是可执行命令、参数、枚举的当前版本能力来源；在线文档补充项目类型、条件、产物与前置，不能代替本机 capability gate。切换 CLI 后必须重算，不能继续使用旧 choice 或猜新参数。
7. [小程序发行](https://hx.dcloud.net.cn/cli/publish-miniProgram)、[Web 发行](https://hx.dcloud.net.cn/cli/publish-h5)、[App 资源](https://hx.dcloud.net.cn/cli/publish-app-appResource)保留旧语法 `cli publish --platform …`，并注明 4.67-alpha+ 使用 `publish mp-weixin`／`publish web`／`publish app-ios` 等拆分命令。旧版 root `publish` 只有实际 help 暴露的 platform 枚举才能构造模式；没有枚举时应解释能力未核实，不能猜平台、隐藏必要 platform 或误标成云打包。本次本机只读 help 为拆分命令；旧语法的 fixture 验证不是旧版宿主实测。

## 本轮改动前缺口审计

审计基线：`src/task-catalog.ts` 的 taskChoices、`src/app.ts` command、`src/hx.ts` arguments。

- 每个 command 一个 choice；App 即便支持 compile 也无独立仅编译入口，publish 都平铺为“发行”，没有资源/WGT/Web 本地/托管/小程序上传模式。
- app 按 command 对象反查 choice；同命令多个预设需要稳定 choice identity，否则选中的产物/模式会丢失。
- 泛化表单只用 help 静态 required，缺平台、证书、上传条件；没有串联设备查询。模式决定后必须锁定对应 type/compile/upload 等值，不能靠用户猜字符串。
- config 与自动项目注入冲突；backend 已正确禁止混用，UI 需绑定配置内目标并提供单独配置流程。
- Web/小程序仅编译和 iOS 模拟器限制是已批准的安全边界，不是应该删除的 backend 缺陷；需要可见说明而不是把导航或模式整体隐藏。
- HXClient 已限制 ui、未知参数、当前 help 枚举、非 pack argv 密码及 config 混用；界面补全不能绕过最后校验。

上轮运行发行实现后的独立验收见 [README](../README.md) 的“上轮运行发行与常驻导航验收（2026-10-28，旧导航行为）”：当时 macOS arm64 / Bun 1.4.2 完整 smoke（11 tests、0 fail）及 platform smoke 通过，真实 PTY 核对模式、产物、B 项目 argv、常驻导航、长确认缩放与鼠标取消。该导航条设计已被本轮双列表常显替代；当前停止与导航验收见 README 的“双列表导航与本地停止验收（2026-10-28）”（独立 smoke 13 tests、0 fail、15,619 expect 及 platform smoke 通过，另有真实 PTY 本地停止证据）。旧版帮助和跨项目类型能力使用隔离 fixture；没有实际部署／签名／云发行。上节仍保留为改动前缺口，不与最终实现状态混写。
