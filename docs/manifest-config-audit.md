# manifest 全配置能力检查

日期：2026-10-26。范围：用户截图中的 22 个侧栏入口（含源码视图），以普通 uni-app 为主；不能用 uni-app x 的 schema 代替普通 uni-app 全配置。

## 结论与证据边界

配置能力必须拆成四层：配置字段、配套文件、生成/导入等动作、远程账号或服务。CLI 能消费配置并构建，不代表提供了这些配置动作的等价命令。

本次检查了截图全部分类的官方文档，并交叉检查本机安装包中可读的界面组件。已证实字段落点和若干非字段操作；没有逐个点击原生配置页，也没有执行付费、上传、授权、签名或生成用户资源。下表是能力审计，不是功能已实现/全部按钮实测通过的声明。

- **配置**：有官方文档的本地配置落点；[INFERENCE] TUI 可自行实现表单读写，仍须实现类型、依赖、版本和项目类型规则。
- **资源**：除了写配置，还要选择、校验、复制、转换或生成真实文件。
- **远程**：涉及应用 ID、SDK 服务开通、密钥、证书或云端授权；仅写配置不能完成。
- **未闭环**：当前证据不足以证明能严格全程终端完成，不代表绝对无法实现。

## 逐类检查表

| # | 分类 | 已核实的配置/资源 | 除字段外必须覆盖的操作与边界 |
| --- | --- | --- | --- |
| 1 | 基础配置 | 根节点 name、appid、description、versionName、versionCode、locale、networkTimeout、debug 等 [M] | DCloud appid 由云端分配，不等于微信等平台 appid；不能把任意填写字符串当成申请/关联应用已经完成。普通文本、数值和开关可由 TUI 表单编辑；在线身份动作需独立接入 |
| 2 | 安卓/iOS 图标配置 | `app-plus.distribute.icons.android/ios`，Android 密度槽、iPhone/iPad/App Store 各槽 [I][A] | 原图选择、多尺寸生成、替换/保留手动配置策略、真实 PNG 写入、路径回填、生成目录浏览；iOS 要检查 alpha，不能只修改扩展名。当前 CLI 帮助未见专门生成图标命令 |
| 3 | 安卓/iOS 启动界面配置 | `app-plus.splashscreen` 的关闭/等待策略；`app-plus.distribute.splashscreen` 的平台样式和资源 [S][A] | 通用启动界面、自定义图片、Android `.9.png`、iOS storyboard ZIP 是不同资源流程；多尺寸文件、ZIP 内容及引用必须校验。不能把通用启动界面的打包时自动适配说成所有自定义资源都已自动生成 |
| 4 | 安卓/iOS 模块配置 | `app-plus.modules` 与 `app-plus.distribute.sdkConfigs`；定位、地图、登录、支付、推送、分享、语音、统计等 [M][A] | 平台选择、SDK 参数联动、密钥配置及服务开通是不同动作。广告、推送、一键登录等可能在云打包时自动取得服务参数，但前置开通不因此消失。App SDK 的微信 appid 与小程序 appid 不能混用 |
| 5 | 安卓/iOS 权限配置 | Android permissions/custompermissions 与申请策略；iOS privacyDescription、capabilities 等 [A] | 本机原生文案还明确有“是否同时去除模块所使用的 Android 权限”联动确认。模块/插件带入权限和用户自定义权限要区分；保存后需通过构建产物确认实际权限，不能仅凭 UI 勾选声称应用权限已生效。OS 运行时授权不是配置编辑 |
| 6 | 安卓/iOS 原生插件配置 | `app-plus.nativePlugins`；截图有本地及云端选择 [A] | 本地插件目录、参数、平台元数据、云端插件列表与已有授权需分别处理。`uni_modules` 不是此页完整替代；购买、试用、绑定及选择流程未闭环 |
| 7 | 安卓/iOS 常用其它设置 | Android 包名、SDK/ABI、schemes、混淆/资源优化；iOS appid、deploymentTarget、URL schemes、关联域、IDFA；App 横竖屏、UserAgent 等 [M][A] | 必须区分普通配置、签名/关联文件和云端能力；本地原生打包不保证自动应用云打包配置。不能把“常用其它”视为无副作用的单一 JSON 表单 |
| 8 | 鸿蒙 App 配置 | `app-harmony.distribute` 的 bundleName、signingConfigs、前景/背景图标、splashScreens、modules；useragent、主题/安全区 [M] | 调试/发布签名两套配置、私钥库、证书、profile 文件；官方另有“自动获取调试证书”操作。填写证书路径不等于实现自动获取。鸿蒙 SDK 参数及工具链独立于 Android/iOS |
| 9 | Web 配置 | `h5` 的 title、template、router、devServer、publicPath、optimization、sdkConfigs 等 [M] | HTML 模板、主题/静态资源和地图密钥；Vue2/Vue3 使用模板及开发服务器配置存在差异。地图服务申请/域名授权不是 manifest 写入；不能机械复制同一组字段到所有项目 |
| 10 | 微信小程序配置 | `mp-weixin` appid、setting、permission、requiredPrivateInfos、后台模式、workers、plugins、优化、云函数目录；本机还有 uniPush 和 secureNetwork 开关 [M][L] | 编译/压缩/域名检查是本地设置；真实白名单、隐私接口准入、插件授权在平台侧。安全网络还需应用/云空间绑定、云端凭据和依赖模块；uniPush 另有申请开通。不能用 `urlCheck:false` 或 `secureNetwork.enable:true` 冒充完整配置 |
| 11 | 百度小程序配置 | `mp-baidu` appid、后台音频、prefetches、optimization、dynamicLib、nativeTags 等 [M] | 需处理平台项目配置 `project.swan.json`；平台注册/授权与填写 appid 分开。字段及能力不能直接套用微信 |
| 12 | 抖音小程序配置 | `mp-toutiao` appid、projectname、setting、跳转列表、nativeTags 等 [M] | 对应 `project.tt.json`；域名检查、转换、压缩等开关与平台真实白名单/审核是不同事项 |
| 13 | 支付宝小程序配置 | `mp-alipay` plugins、component2、enableAppxNg、AXML 检查、并行加载、构建压缩、Babel、样式隔离等 [M] | `mini.project.json`/`project.my.json` 等配套文件；身份、开发工具上传密钥、插件授权不是一个布尔开关 |
| 14 | QQ 小程序配置 | `mp-qq` appid、后台能力、跳转、permission、workers、groupIdList、优化等 [M] | `project.qq.json`/`project.config.json` 的版本差异；群能力和平台权限不能由改配置自行获得 |
| 15 | 快手小程序配置 | `mp-kuaishou` appid、projectname、optimization、插槽编译模式、nativeTags 等 [M] | `project.ks.json` 及平台账号配置；部分 Vue2 插槽默认值与其他平台不同，不能统一默认值覆盖 |
| 16 | 飞书小程序配置 | `mp-lark` appid、projectname、setting、插槽模式、nativeTags 等 [M] | `project.lark.json`、平台应用申请和权限独立；不能仅换平台名复用抖音全部行为 |
| 17 | 京东小程序配置 | 本机原生文案明确有 `mp-jd.appid`、统计平台开关；官方列出 Vue3 的 `project.jd.json` 与 Vue2 的 `project.config.json` [M][L] | 当前 manifest 总文档无独立京东字段表。已有 AppID/统计控件证据，但本机 CLI 有运行目标不证明此页全部字段与按钮已核实；剩余字段级及动作级覆盖仍有证据缺口，不能编造一套微信式字段 |
| 18 | 小红书小程序配置 | `mp-xhs` appid、projectname、description、compileType、libVersion、condition、setting、packOptions、nativeTags、优化等 [M] | 配套 `project.xhs.json`/`project.config.json`；基础库、打包、平台账号与授权分别处理 |
| 19 | 快应用配置 | `quickapp-webview` icon、package、versionName/versionCode；华为/联盟独立 minPlatformVersion [M] | 图标真实文件、包名与版本；华为及联盟配置不能合并为同一平台。不要把总表中旧 `quickapp` 的“即将支持”误当作已废弃全部快应用配置 |
| 20 | 鸿蒙元服务配置 | `mp-harmony.distribute` bundleName 和 signingConfigs；nativeTags [M] | 包名格式 `com.atomicservice.[纯数字appId]`，调试/发布签名及自动获取调试证书；与鸿蒙 App 类似但不是同一应用类型，自动取证流程未闭环 |
| 21 | uni统计2.0 配置 | `uniStatistics` 全局开关、版本/公私版、debug、reportInterval、collectItems，以及分平台 enable [T] | 私有版还需云空间与 uni-admin 后台部署、部分小程序域名白名单。公有/私有版不能同时开启；配置统计不等于部署成功或已有报表。不能把 2.0 页面归结为一个 enable 开关 |
| 22 | 源码视图 | manifest JSON 配置；官方示例包含注释，并存在项目类型/版本不同节点 [M][A] | 表单与源码应编辑同一文档，保留未建模字段，不能全量重建只保留已知字段。还需照顾相关 project.*.json、资源及本地化文件，不能以原始源码框冒充其他 21 页的交互 |

## 图标页的明确验收对象

用户新截图已经直接确认以下交互，不需要再猜：原图“浏览”、不替换手动设置图标、自动生成所有图标并替换、浏览生成目录、各尺寸手动选择。TUI 的“浏览目录”应在终端中呈现路径与文件，而不是启动 Finder/资源管理器。

[I] 给出的 Android 常用尺寸为 72、96、144、192，另有旧设备密度槽；App Store 1024，iPhone/iPad 还有不同用途尺寸。一张图可能写入不同配置槽，但不能丢失槽位映射。iOS 图标必须为 PNG、直角、不含 alpha。是否保留手动配置应同时约束配置引用及覆盖哪些已有生成文件，而不是只有一个不生效的复选框。

## 随包实现交叉核实

以下路径均在本机 HBuilderX 5.24 安装包的 `Contents/HBuilderX/plugins` 下，检查未执行这些动作：

- **原生图标生成**：`hx-language-pack-zh-cn/main.i18n.json:872-876,2519-2524` 明确给出生成、保留手动图标、输出目录 `unpackage/res/icons` 和 PNG 校验文案，与截图一致。
- **基础配置的远程动作**：同一语言包 `:2515-2517` 有“请先登录，再使用云端获取Appid功能”；`uniapp-extension/static/vue/manifestJson/manifestJsonBasicPage.vue:179-224` 中 x 页面实际通过账号服务 HTTP 请求获取 AppID，非本地随机生成。只读取实现，没有调用该接口。
- **权限联动**：语言包 `:2526-2527` 有移除模块时同时移除 Android 权限的确认；表单实现必须保留这类行为，而不是仅列字段。
- **uniPush 与安全网络**：语言包 `:4651-4654` 有申请开通链接及安全网络说明；随包 `hbuilderx-ai-chat/uni-agent/knowledges/unicloud/docs/secure-network.md:80-129` 列出微信应用绑定、空间关联、uni-id/uni-open-bridge 依赖及云端配置。微信 secret 不应被放入前端 manifest。官方对应[安全网络文档](https://doc.dcloud.net.cn/uniCloud/secure-network.html)。
- **京东与元服务**：语言包 `:4964-4976` 明确包含京东 AppID/统计，以及元服务去 AGC 创建应用取得包名的链接。
- **鸿蒙自动取证**：`launcher/static/vue/SigningConfigs.vue:14-35,205-235` 实际调用设备检测和自动生成管理器；随包 `hbuilderx-ai-chat/uni-agent/knowledges/uni-app-x/docs/tutorial/runbuild.md:289-323` 明确通过 AGC API 申请，先触发浏览器华为登录授权，要求 APP ID 与设备注册，且不支持自动申请含 ACL 权限的调试证书。因此这是当前已发现的、与严格禁止外部 GUI 冲突的真实流程，不只是笼统“可能需要后台”。官方对应[鸿蒙签名说明](https://uniapp.dcloud.net.cn/tutorial/harmony/runbuild.html#signing)。
- **项目类型差异**：这组 Vue 表单主要写 x 的 `app-android`、`app-ios`、`web`、`uni-app-x` 节点，classic 则主要使用 `app-plus`、`h5`。Vue 文件中的浏览按钮只选路径并提交 JSON，不生成图标；部分模板控件还在注释中，不能用文件名或 schema 字段存在来证明实际界面覆盖。

[L] 指上述本机原生语言包及相应随包实现；它证明控件文案/动作线索，不单独证明所有控件在所有项目类型均显示。


## CLI 直接覆盖的验证

在检测到本机 HBuilderX 已运行后，仅执行 `cli --help`，未启动/退出 GUI、未修改项目：返回码 0。提取其可见命令名后，没有匹配 icon、splash、permission、manifest、sdk、statistic、certificate、nativeplugin 的专门配置动作名称。存在 `config get/set`、`project ...`、`uni_modules`、`installPlugin` 等。

这个结果只证明本机帮助没有暴露相应专门命令，不能据此否认内部 API 或其他版本存在能力。已有 `pack` 参数、资源路径及编译命令能消费配置，并不是自动生成资源、开通 SDK、获取证书的同义操作。[C]

## 尚未证实能全程终端完成的部分

- DCloud 应用身份申请/关联、各 SDK 服务的开通、密钥及绑定操作。
- 原生插件云端选择及授权闭环。
- 鸿蒙 App/元服务自动获取调试证书。
- 配置页可能启动的其他外部账号/认证流程。
- 京东配置页逐字段及逐动作定义。

图标生成、PNG 转换、文件选择、storyboard ZIP 检查等不因缺少 CLI 命令就成为不可能：[INFERENCE] 可以由 TUI 自己实现；但这属于额外实现，不是已有 CLI 的已验证能力。统计后台部署也可以复用已支持的云开发/托管命令中的部分步骤，不等于整个部署向导已自动等价。

## 来源

- [M — manifest 总表、各平台与配套项目配置](https://uniapp.dcloud.net.cn/collocation/manifest.html)
- [A — App Android/iOS 与完整 manifest](https://uniapp.dcloud.net.cn/collocation/manifest-app.html)
- [I — App 图标](https://uniapp.dcloud.net.cn/tutorial/app-icons.html)
- [S — App 启动界面](https://uniapp.dcloud.net.cn/tutorial/app-splashscreen.html)
- [T — uni统计2.0 私有版及配置/部署边界](https://uniapp.dcloud.net.cn/uni-stat-private.html)；旧 [2.0 文档](https://uniapp.dcloud.net.cn/uni-stat-v2.html)已指向此页，审计时不能假定截图版本与最新文档字段完全一致。
- [C — CLI 配置](https://hx.dcloud.net.cn/cli/config)、[CLI 总览](https://hx.dcloud.net.cn/cli/README)及本机只读帮助。
