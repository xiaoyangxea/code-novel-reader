# Code Novel Reader - 代码小说阅读器

[从 VS Code Marketplace 安装](https://marketplace.visualstudio.com/items?itemName=xiaoyangxea.code-novel-reader) · [查看最新版本](https://github.com/xiaoyangxea/code-novel-reader/releases/latest) · [反馈问题](https://github.com/xiaoyangxea/code-novel-reader/issues) · [安全报告](SECURITY.md)

把在线或本地小说显示为 VS Code 原生 TypeScript 文档中的 `//` 注释。阅读页面不是 Webview，语法高亮、滚动条、标签页和普通代码文件一致。

这是一个给开发者摸鱼看小说的小工具：正文伪装成 TypeScript 注释，页面外观和普通代码文件几乎一样，不需要在编辑器与浏览器之间来回切换；遇到有人靠近时，还可以用老板键立即把小说内容替换成正常的诊断代码。

## 功能

- 在线搜索：可并行搜索内置来源、自定义书源、Bing、DuckDuckGo 和百度；过滤分类和明显无关结果，准确书名优先，支持补搜和查看来源状态。
- URL 导入：支持书籍目录页、分页目录或任意章节 URL；目录可用时弹出可搜索的完整章节列表，只有单章链接时可沿上下章继续扩展。
- 通用网页解析：专用 CSS 规则优先，正文密度算法兜底；自动识别标题、分页目录、分页正文、上下章，并清理常见隐藏反采集文本。
- 浏览器回退：普通抓取失败时自动查找本机 Chrome、Edge、Chromium 或 Brave；Headless 被拦截时可从普通隔离浏览器的临时缓存安全回读公开页面。
- 本地阅读：支持 TXT、Markdown、TEXT 和 EPUB；自动识别 UTF-8、GBK/GB18030、UTF-16LE。
- TypeScript 伪装：正文以 `//` 注释混入诊断代码模板。
- 翻页与翻章：编辑器按钮会根据当前位置自动显示“上一页/下一页”或“上一章/下一章”，章节末尾继续翻页会自动进入下一章。
- 老板键：立即显示默认 TypeScript 模板或自定义文本快照，恢复时保留章节与页码；后台预取和整书下载继续运行。
- 进度与缓存：翻页后自动合并保存进度，在线章节抓取后本地缓存，并默认在后台维持后续 3 章的预取窗口。
- 书架清理：移除本地书籍时可同时将 TXT/EPUB 源文件移入系统回收站；移除在线书籍会清理章节缓存。
- 书架目录：每本书右侧提供小型目录和删除图标；目录可按章节名或序号搜索，在线目录可以刷新。
- 书源管理：支持本地 JSON、粘贴 JSON、订阅 URL，以及根据目录 URL 自动生成安全书源。
- 网络发现：可选接入用户自己的 Brave Search API Key，自动探测搜索结果中的小说目录。
- 本地下载：支持整书或章节范围下载、暂停续传及 TXT 导出，已缓存章节可离线阅读。

## 安装

推荐直接打开 [Marketplace 页面](https://marketplace.visualstudio.com/items?itemName=xiaoyangxea.code-novel-reader)，或在 VS Code 扩展面板搜索：

```text
@id:xiaoyangxea.code-novel-reader
```

从 Marketplace 安装后可以接收自动更新。离线安装可从 [GitHub Releases](https://github.com/xiaoyangxea/code-novel-reader/releases/latest) 下载 VSIX，然后执行 `Extensions: Install from VSIX...`。

早期 `0.3.1` 及以下版本使用旧扩展 ID `local-hu.code-novel-reader`，需要先卸载一次旧版，再安装 Marketplace 版本；此后升级无需重复卸载。

## 使用

点击活动栏的书本图标：

- 放大镜：搜索在线小说。
- 链接：粘贴目录页或章节 URL。
- 文件夹：打开本地 TXT/EPUB。
- 服务器图标或书架中的“书源管理”：导入、测试和管理书源。
- 点击书架中的书名继续阅读。

书籍右侧只保留“目录”和“删除”两个小图标，右键可以继续阅读或刷新目录。URL 导入完成后会弹出可搜索的章节目录。编辑器右上角的左右按钮会根据当前位置显示“上一页/下一页”，到章节边界时自动切换为“上一章/下一章”；每次翻页或翻章后都会定位到新内容顶部。

书架右键“下载到本地 / 导出 TXT”可下载整书或指定序号范围（如 `1-100`），也可暂停、继续、取消或重试失败章节。下载任务跨重启保存，但重启后需要手动继续；网站验证或请求失败时自动暂停。下载与阅读共用缓存，阅读请求优先，已经发出的后台请求会完成后再切换。单次下载正文上限为 256 MB。

TXT 导出可选择整本目录或本次下载范围，按章节顺序写入正文；未缓存章节会明确标记，导出上限为 64 MB。文件保存到用户选择的位置，移除书架只清理插件缓存，不删除已导出的 TXT。整书下载需要可用目录；若只有单章链接，应先导入目录 URL。

运行“代码小说: 设置老板键显示内容”，可以编辑多行内容、导入本地文件快照、预览或恢复默认模板。编辑完成后执行“代码小说: 保存当前编辑器为老板键内容”。内容只作显示、不执行代码，最大 256 KB；修改原文件后需要重新导入快照。快捷键可在 VS Code 的“键盘快捷方式”中修改。

快捷键：

| 功能 | Windows/Linux |
| --- | --- |
| 上一页 / 下一页 | `Alt+Left` / `Alt+Right` |
| 上一章 / 下一章 | `Alt+Shift+Left` / `Alt+Shift+Right` |
| 章节列表 | `Ctrl+Alt+L` |
| 老板键 | `Ctrl+Alt+B` |

## 蚂蚁文学

以下两种 URL 均可导入：

```text
https://www.mayiwsk.com/150_150607/
https://www.mayiwsk.com/150_150607/59106813.html
```

输入目录 URL 后会先规范化目录顺序，再弹出章节选择框。蚂蚁文学目录页顶部重复的“最新章节”区块不会再被当成目录开头。输入单章 URL 时，扩展会先识别正文与目录链接，再尝试加载完整章节列表；目录不可用时，会沿“上一章/下一章”动态扩展。

## 已适配站点

| 站点 | 搜索 | URL 导入 | 专用目录/正文规则 |
| --- | --- | --- | --- |
| 蚂蚁文学 | 是 | 是 | 是 |
| 苦读书 | 是 | 是 | 移动目录、目录分页和正文分页；遇到验证时转入人工确认流程 |
| 速读谷 | 是 | 是 | 新 `.cc` 搜索入口、目录分页和正文规则 |
| 启迪小说 | 否 | 是 | 分页目录、正文分页、普通浏览器缓存回退和批量目录读取 |
| 书海阁小说网 | 否 | 是 | 目录去重排序和正文规则 |
| 小说之家 | 否 | 是 | 移动目录分页和正文规则；遇到验证时停止自动读取 |
| 天天看小说 | 实验，默认关闭 | 是 | 目录和正文规则；新增搜索仍需在用户网络中测试 |
| 得奇小说网 | 实验，默认关闭 | 实验 | 候选搜索与通用目录/正文规则，尚未通过完整在线验证 |
| 快书网 | 实验，默认关闭 | 实验 | 候选搜索与通用目录/正文规则，尚未通过完整在线验证 |
| 手机小说 | 实验，默认关闭 | 实验 | POST 表单搜索与通用目录/正文规则，尚未通过完整在线验证 |
| 笔趣阁 365 | 否 | 是 | 移动/桌面目录和正文规则；遇到验证时停止自动读取 |
| 纵横中文网 | 是 | 是 | 搜索、目录和公开章节规则 |
| 维基文库 | 是 | 是 | 是 |
| 69书吧 | 否 | 是 | 是；遇到 Cloudflare 验证时会明确停止 |
| 17K小说网 | 否 | 是 | 是；仅限可直接访问的公开页面 |
| 晋江文学城 | 否 | 是 | 是；不读取锁定或登录章节 |
| 起点中文网 | 否 | 是 | 公开章节规则，不处理付费或登录内容 |
| QQ 阅读 | 全网发现 | 是 | 公开目录排序和正文规则；试读遮罩、疑似截断及付费内容不会当作完整正文 |

此外还保留未知站点的通用结构和正文密度识别。网站结构、域名和访问策略可能随时变化；表格只表示扩展包含对应解析规则，并不保证站点始终可访问，也不代表插件认可页面内容的版权状态。

候选站点来自 [XIU2/Yuedu](https://github.com/XIU2/Yuedu) 的站点发现线索，并参考 [aoaostar/legado](https://github.com/aoaostar/legado) 和 [speauty/legado.sources](https://github.com/speauty/legado.sources) 的来源维护方式；插件没有打包这些仓库的原始 Legado 合集或脚本。书源管理中可查看出处、启停来源，并测试搜索、目录与第一章，验证结果和日期保存在本机。

2026-10-12 在 Clash Verge TUN 环境中，速读谷已通过搜索、目录首页（186 章）和第一章正文检查；实验来源仍未通过完整检查：得奇连接超时，快书证书校验失败，天天看搜索可解析但目录读取失败，手机小说搜索未识别结果。这些是当次网络下的结果，不代表站点对所有用户都不可用。实验来源默认关闭，可在书源管理中启用并测试。维护者可运行 `node scripts/check-sources.mjs`，加 `--browser` 验证浏览器回退，或加 `--source=速读谷` 只测指定来源。

## 网络与代理排错

扩展会识别代理软件常见的 `198.18.0.0/15` 和 `2001:2::/48` Fake-IP；遇到时通过 DNS-over-HTTPS 获取真实公网地址，配置代理时 DNS 请求也走该代理。代理按以下优先级读取：

1. `codeNovel.proxy`
2. VS Code 的 `http.proxy`
3. `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 环境变量
4. 本机 Clash Verge 的已监听混合端口（默认启用 `codeNovel.autoDetectProxy`）

自动检测只读取 Clash Verge 本地配置的端口字段，不修改代理配置，也不读取订阅或节点凭据；目前主要针对 Clash Verge Rev 的常见配置位置。TUN 模式通常无需手动填写端口；检测不到时仍可显式设置。启动代理或修改端口后可运行 `Developer: Reload Window` 重新检测。其他代理软件、不同安装位置和 SOCKS-only 端口请使用 HTTP/HTTPS 混合端口手动配置。

例如 Clash Verge 的混合代理端口是 `7897` 时：

```json
{
  "codeNovel.proxy": "http://127.0.0.1:7897"
}
```

如果普通请求拿不到正文，扩展默认会在 Windows、macOS 和 Linux 的常见安装位置查找 Chrome、Edge、Chromium 或 Brave，并用独立于日常浏览器的配置目录重试。必要时可在用户全局设置中填写 `codeNovel.browserExecutable`；工作区不能指定任意可执行文件。

在线阅读默认在当前章打开后依次预取后续 3 章，翻章时会优先使用本地缓存，并在进入下一章后继续补齐滑动窗口。可通过 `codeNovel.prefetchChapterCount` 设置预取 `0–10` 章，或关闭 `codeNovel.prefetchNextChapter` 总开关。预取失败后会停止当前窗口并等待用户实际阅读时重试。切书或扩展停用时停止继续预取，老板键只切换显示、不暂停预取和整书下载。预取、下载与显式阅读共用串行网络队列，避免重复抓取同一章节。

如果站点只拦截 Headless，扩展会短暂启动最小化的普通隔离浏览器，并从本次请求的临时 Chromium 缓存中按完整 URL 读取响应；读取结束后会关闭该进程并清理临时缓存。隔离窗口会关闭翻译提示和异常退出后的“恢复页面”气泡，不会改动日常浏览器的偏好设置。该方式不连接 DevTools，不扫描或解析日常浏览器数据。对于分页较多的启迪小说和苦读书目录、正文，会每批读取最多 5 页，并在加载提示中显示分页进度。

普通请求保留原始域名、Host 和 TLS 校验，只把代理 CONNECT 目标固定到已验证的公网 IP，避免代理下出现域名错配或重定向循环。隔离浏览器使用同一显式代理，并经过只监听本机回环地址的临时转发器；HTTP/CONNECT 请求及子资源的目标都会校验和固定公网地址，关闭读取任务后释放转发器。代理凭据不会写入浏览器启动参数。不使用显式代理时，浏览器仍固定首个目标主机，但子资源遵循浏览器自身的网络模型；只应对信任的公开站点启用浏览器回退。

“来源状态”和书源测试会区分连接/代理失败、证书错误、需要验证和解析失败。证书失败请检查站点证书或代理链；插件不会关闭 HTTPS 证书校验。

遇到 HTTP 429 限流时，同站请求会按 `Retry-After` 暂停（最长 5 分钟），不会切换浏览器绕过；其他来源仍可继续使用。自动读取超时会清理本次创建的浏览器进程树，不关闭日常浏览器或人工验证窗口。

遇到人机验证时，扩展会询问是否打开专用验证窗口。完成验证或确认页面可以正常显示后，手动关闭窗口并重试。若普通浏览器能打开、站点却仍拒绝插件自动读取，扩展会停止重复验证并给出明确提示。验证结果只保存在插件的隔离目录中，可运行“代码小说: 清除专用浏览器数据”删除。浏览器可以打开并不等于插件一定能解析：登录、付费、内容绘制在图片/Canvas 中，或站点持续改变结构时仍会失败。扩展不会绕过这些限制。

人工验证窗口使用代理时请保持 VS Code 打开：窗口关闭、扩展停用或超过 30 分钟后，临时代理转发器会释放。

## 书源管理

在书架中点击“书源管理”，可以：

- 导入本地 JSON 文件、粘贴 JSON 或订阅 URL。
- 粘贴一本书的目录 URL，自动分析目录和第一章并生成书源。
- 启用、禁用和测试书源；从订阅地址更新规则。
- 复制、替换、导出或删除自己的书源。

书源是纯 JSON 声明式规则，支持 URL 模板、CSS 选择器和受限制的搜索表单，不允许 JavaScript、`eval`、命令、Cookie、Authorization 或自定义请求头。例如：

```json
{
  "version": 1,
  "name": "示例小说网",
  "domains": ["books.example.com"],
  "search": {
    "url": "https://books.example.com/search?q={keyword}",
    "resultSelector": ".search-result",
    "titleSelector": ".book-title",
    "urlSelector": ".book-title",
    "authorSelector": ".author"
  },
  "catalog": {
    "titleSelector": "h1",
    "chapterSelector": "#chapter-list a"
  },
  "chapter": {
    "titleSelector": "h1",
    "contentSelector": "#content",
    "previousSelector": "a.prev",
    "nextSelector": "a.next",
    "catalogSelector": "a.catalog"
  }
}
```

导入书源与导入书籍 URL 是两个不同操作：书源描述一个网站的解析方式；书籍 URL 只把某一本书加入书架。直接导入书籍 URL 时，如果域名匹配已启用的自定义书源，会自动使用对应规则。

搜索 URL 支持 `{keyword}` 和可选的 `{page}`，也可用 `nextPageSelector` 指定下一页链接；每次搜索最多按需加载 5 页。需要 POST 搜索的来源可在 `search` 中增加 `"method": "POST"`、`"form": {"searchkey": "{keyword}"}` 和 `"charset": "gbk"`（可选编码还有 `utf-8`、`gb18030`）。表单不允许凭据字段，自定义书源的普通请求重定向也会检查域名声明；POST 搜索失败时不会把表单误当成 GET 打开浏览器。

### 网络发现

在线搜索中可以选择“网络发现”，或在结果列表中选择“扩大搜索范围”。首次使用需要填写自己的 Brave Search API Key，密钥只保存到 VS Code `SecretStorage`。每批获取最多 20 条结果，可按需补搜最多 5 批，并对前 8 条候选快速探测目录首页。用户选择后才加载完整目录；搜索词会发送给 Brave。

无需 API Key 的“聚合书源 + 全网搜索”会同时请求已启用书源、Bing、DuckDuckGo 和百度，也可单独选择站内来源或全网搜索。全网补搜最多 3 批，分别查询“小说目录”“在线阅读”“全部章节”；不是网页翻页，同一 URL 会去重。支持输入 `三体 刘慈欣`，全网查询分别为书名和作者加引号，站内来源先搜书名再筛选。分类导航、法律文书、常见百科、社交和下载页会被过滤；准确书名优先于系列、续作和同人。匹配标签只说明标题关系，不保证是原作，请核对作者。

搜索到作者作品页时，扩展可读取同站书籍链接作为候选，不直接导入作者主页。每批最多额外读取 2 个作者页，每页限 1 MB、7 秒，不递归也不启动浏览器；来自作者页的推断作者会明确标记，目录探测时重新核对。

结果先显示，再对排序后的前 8 条候选探测目录首页；只有目录标题、可用作者信息匹配且存在章节时才标记“目录已识别，正文未验证”，其余明确显示“网页候选，待验证”。目录已识别不等于正文一定可读，也不代表属于免费正版；试读遮罩及疑似截断片段会明确报错，不当作完整正文缓存。登录、收费和访问限制不会被绕过。搜索词会发送给所选服务，搜索网站的验证和页面变化可能使入口失效。维护者可运行 `node scripts/check-search.mjs 三体 --probe` 检查搜索、目录和第一章正文（不打印正文），或运行 `node scripts/check-search-matrix.mjs` 测试多本书；报告仅记录元数据、正文长度及失败原因，也可继续使用“导入 URL”。

明确倒序的旧在线目录会在打开书籍时自动修正，阅读位置按章节 URL 保留；多卷重新编号不会强行排序。若旧目录包含顶部“最新章节”、缺章或其他误识别项，请在书架右键选择“更新目录”重新解析。

### 旧版兼容搜索入口

旧版 `codeNovel.searchProviders` 设置仍然可用。`{keyword}` 会替换为 URL 编码后的搜索词：

```json
{
  "codeNovel.searchProviders": [
    {
      "name": "我的书源",
      "url": "https://example.com/search.php?searchkey={keyword}"
    }
  ]
}
```

搜索页面如果使用常见的表格、列表或卡片结构，扩展会尝试自动识别，也支持搜索直接跳转到目录或详情页；普通解析失败时可尝试浏览器回退。结果列表的“来源状态”会显示结果数、请求失败或需要验证等信息，慢来源不会阻止已经返回的结果被选择。

## 隐私与使用范围

- 本地文件只在本机读取。
- 在线导入和阅读请求公开页面、同一本书的分页目录及章节链接；启用预取或下载后，也会请求对应的后续章节或下载范围。
- 书源和网络发现只允许 HTTP/HTTPS 地址，并拒绝明显的本机、局域网和带账号信息的 URL；单次网页响应限制为 8 MB。
- 每次重定向都会重新验证目标；直连和代理请求都会检查全部 DNS 结果并固定到已验证的公网地址，阻止常见 SSRF 和 DNS 重绑定方式。
- 自定义书源只能访问其 `domains` 声明的域名；复杂 CSS 选择器、跨域章节链接、过量并发和超大订阅都会被拒绝。
- 本地 TXT/EPUB 最大 64 MB；EPUB 会在解压前检查正文展开量、单项尺寸和压缩比，防止 ZIP 压缩炸弹。
- Brave API 默认未配置；只有主动选择时才会向 Brave 发送搜索词。选择聚合加全网或全网搜索时，搜索词会发送给 Bing、DuckDuckGo 和百度；可选择仅站内来源。
- 阅读进度和在线缓存保存在 VS Code 的扩展全局存储目录。
- 浏览器回退使用独立的站点配置目录，不读取日常 Chrome/Edge 配置；缓存回读只检查扩展创建的临时目录和完全匹配的目标 URL，并限制文件、响应及解压后大小。配置代理时，通过本机临时转发器校验 HTTP/CONNECT 的公网目标；没有显式代理时只固定首个目标主机，子资源遵循浏览器网络模型。页面脚本只在隔离浏览器进程中执行，返回扩展后仍只提取文本。可随时通过命令清除验证数据。
- 移除本地书籍时，只有明确选择“移除并删除源文件”才会把原文件移入系统回收站。
- 老板键用于快速切换显示内容，不是加密或安全隔离功能。
- 请仅阅读你有权访问的内容，并遵守内容网站的服务条款。

## 本地开发

开发和打包需要 Node.js 22 或更高版本；自动发布工作流使用 Node.js 22。

```powershell
npm ci
npm run check
npm test
npm run audit:security
npm run package
```

打包完成后会在项目根目录生成 `code-novel-reader-<version>.vsix`。如需报告解析问题，请参阅 [SUPPORT.md](SUPPORT.md)。

## 发布新版本

仓库配置了 Marketplace 自动发布。更新 `CHANGELOG.md` 并确认测试通过后，可以执行：

```powershell
npm version patch --no-git-tag-version
npm run audit:security
npm run package
$releaseVersion = node -p "require('./package.json').version"
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: v$releaseVersion"
git tag -a "v$releaseVersion" -m "Release v$releaseVersion"
git push origin main
git push origin "v$releaseVersion"
```

先确保功能代码已经提交，再执行上述版本提交。GitHub Actions 会校验标签与 `package.json` 版本完全一致，然后重新审计、测试、打包并发布；例如版本 `0.6.1` 必须使用标签 `v0.6.1`。发布凭据目前保存在仓库的 `VSCE_PAT` Actions Secret 中，不应写入源码。微软已宣布全局 Azure DevOps PAT 将于 2026 年 12 月 1 日退役；应在此前按 [VS Code 官方发布说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) 迁移到 Microsoft Entra ID 自动发布方式。
