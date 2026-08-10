# Code Novel Reader - 代码小说阅读器

[从 VS Code Marketplace 安装](https://marketplace.visualstudio.com/items?itemName=xiaoyangxea.code-novel-reader) · [查看最新版本](https://github.com/xiaoyangxea/code-novel-reader/releases/latest) · [反馈问题](https://github.com/xiaoyangxea/code-novel-reader/issues) · [安全报告](SECURITY.md)

把在线或本地小说显示为 VS Code 原生 TypeScript 文档中的 `//` 注释。阅读页面不是 Webview，语法高亮、滚动条、标签页和普通代码文件一致。

这是一个给开发者摸鱼看小说的小工具：正文伪装成 TypeScript 注释，页面外观和普通代码文件几乎一样，不需要在编辑器与浏览器之间来回切换；遇到有人靠近时，还可以用老板键立即把小说内容替换成正常的诊断代码。

## 功能

- 在线搜索：提供多个内置搜索入口，并可在设置中添加兼容的 HTML 搜索入口。
- URL 导入：支持书籍目录页、分页目录或任意章节 URL；识别后弹出可搜索的完整章节列表。
- 通用网页解析：专用 CSS 规则优先，正文密度算法兜底；自动识别标题、分页目录、分页正文、上下章，并清理常见隐藏反采集文本。
- 浏览器回退：普通抓取失败时自动查找本机 Chrome、Edge、Chromium 或 Brave；Headless 被拦截时可从普通隔离浏览器的临时缓存安全回读公开页面。
- 本地阅读：支持 TXT、Markdown、TEXT 和 EPUB；自动识别 UTF-8、GBK/GB18030、UTF-16LE。
- TypeScript 伪装：正文以 `//` 注释混入诊断代码模板。
- 翻页与翻章：编辑器按钮会根据当前位置自动显示“上一页/下一页”或“上一章/下一章”，章节末尾继续翻页会自动进入下一章。
- 老板键：立即用正常 TypeScript 诊断管线替换全部阅读内容。
- 进度与缓存：翻页后自动合并保存进度，在线章节抓取后本地缓存，并默认在后台维持后续 3 章的预取窗口。
- 书架清理：移除本地书籍时可同时将 TXT/EPUB 源文件移入系统回收站；移除在线书籍会清理章节缓存。
- 书架目录：每本书右侧提供小型目录和删除图标；目录可按章节名或序号搜索，在线目录可以刷新。
- 书源管理：支持本地 JSON、粘贴 JSON、订阅 URL，以及根据目录 URL 自动生成安全书源。
- 网络发现：可选接入用户自己的 Brave Search API Key，自动探测搜索结果中的小说目录。

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
| 苦读书 | 是 | 是 | 移动目录、目录分页、正文分页；目前可能要求人机验证 |
| 速读谷 | 是 | 是 | 目录分页和正文已做真实页面验证 |
| 启迪小说 | 否 | 是 | 分页目录、正文分页、普通浏览器缓存回退和批量目录读取 |
| 书海阁小说网 | 否 | 是 | 目录去重排序和正文规则 |
| 小说之家 | 否 | 是 | 移动目录分页和正文规则；目前可能要求人机验证 |
| 天天看小说 | 否 | 是 | 目录和正文已做真实页面验证 |
| 笔趣阁 365 | 否 | 是 | 移动/桌面目录和正文规则；目前可能要求人机验证 |
| 纵横中文网 | 是 | 是 | 是，已验证搜索、目录和公开章节 |
| 维基文库 | 是 | 是 | 是 |
| 69书吧 | 否 | 是 | 是；遇到 Cloudflare 验证时会明确停止 |
| 17K小说网 | 否 | 是 | 是；仅限可直接访问的公开页面 |
| 晋江文学城 | 否 | 是 | 是；不读取锁定或登录章节 |
| 起点中文网 | 否 | 是 | 公开章节规则，不处理付费或登录内容 |

此外还保留未知站点的通用结构和正文密度识别。网站结构、域名和访问策略可能随时变化；表格只表示扩展包含对应解析规则，并不保证站点始终可访问，也不代表插件认可页面内容的版权状态。

## 网络与代理排错

扩展会识别代理软件常见的 `198.18.0.0/15` Fake-IP；遇到时自动通过 DNS-over-HTTPS 获取真实地址重试。也会依次读取：

1. `codeNovel.proxy`
2. VS Code 的 `http.proxy`
3. `HTTPS_PROXY`、`HTTP_PROXY`、`ALL_PROXY` 环境变量

例如 Clash Verge 的混合代理端口是 `7897` 时：

```json
{
  "codeNovel.proxy": "http://127.0.0.1:7897"
}
```

如果普通请求拿不到正文，扩展默认会在 Windows、macOS 和 Linux 的常见安装位置查找 Chrome、Edge、Chromium 或 Brave，并用独立于日常浏览器的配置目录重试。必要时可在用户全局设置中填写 `codeNovel.browserExecutable`；工作区不能指定任意可执行文件。

在线阅读默认在当前章打开后依次预取后续 3 章，翻章时会优先使用本地缓存，并在进入下一章后继续补齐滑动窗口。可通过 `codeNovel.prefetchChapterCount` 设置预取 `0–10` 章，或关闭 `codeNovel.prefetchNextChapter` 总开关。预取采用单路串行请求，失败后会停止当前窗口并等待用户实际阅读时重试。

如果站点只拦截 Headless，扩展会短暂启动最小化的普通隔离浏览器，并从本次请求的临时 Chromium 缓存中按完整 URL 读取响应；读取结束后会关闭该进程并清理临时缓存。隔离窗口会关闭翻译提示和异常退出后的“恢复页面”气泡，不会改动日常浏览器的偏好设置。该方式不连接 DevTools，不扫描或解析日常浏览器数据。对于分页较多的启迪小说和苦读书目录、正文，会每批读取最多 5 页，并在加载提示中显示分页进度。

为保持与普通请求相同的私网访问边界，专用浏览器会校验并固定目标站点的公网地址，而且不使用 `codeNovel.proxy` 指定的显式代理；系统级 TUN/VPN 仍可正常接管流量。

遇到人机验证时，扩展会询问是否打开专用验证窗口。完成验证或确认页面可以正常显示后，手动关闭窗口并重试。若普通浏览器能打开、站点却仍拒绝插件自动读取，扩展会停止重复验证并给出明确提示。验证结果只保存在插件的隔离目录中，可运行“代码小说: 清除专用浏览器数据”删除。浏览器可以打开并不等于插件一定能解析：登录、付费、内容绘制在图片/Canvas 中，或站点持续改变结构时仍会失败。扩展不会绕过这些限制。

## 书源管理

在书架中点击“书源管理”，可以：

- 导入本地 JSON 文件、粘贴 JSON 或订阅 URL。
- 粘贴一本书的目录 URL，自动分析目录和第一章并生成书源。
- 启用、禁用和测试书源；从订阅地址更新规则。
- 复制、替换、导出或删除自己的书源。

书源是纯 JSON 声明式规则，只支持 URL 模板和 CSS 选择器，不允许 JavaScript、`eval`、命令、Cookie、Authorization 或自定义请求头。例如：

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

### 网络发现

在线搜索中可以选择“网络发现”。首次使用需要在书源管理中填写自己的 Brave Search API Key，密钥只保存到 VS Code `SecretStorage`。插件会搜索网页并对前 8 条结果快速探测目录首页，用户确认后才加载完整目录并导入；不会自动批量下载，也不会把结果标记为“免费正版”。搜索词会发送给 Brave，请根据自己的隐私要求决定是否启用。

没有 API Key 时，可以让扩展在系统浏览器中打开搜索，然后把找到的目录 URL 粘贴回来。

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

搜索页面如果使用常见的表格、列表或卡片结构，扩展会自动识别。站点完全依赖 JavaScript、要求登录或启用反爬验证时无法直接抓取。

## 隐私与使用范围

- 本地文件只在本机读取。
- 在线导入仅请求用户选择的公开页面、同一本书的分页目录及章节链接。
- 书源和网络发现只允许 HTTP/HTTPS 地址，并拒绝明显的本机、局域网和带账号信息的 URL；单次网页响应限制为 8 MB。
- 每次重定向都会重新验证目标；直连和代理请求都会检查全部 DNS 结果并固定到已验证的公网地址，阻止常见 SSRF 和 DNS 重绑定方式。
- 自定义书源只能访问其 `domains` 声明的域名；复杂 CSS 选择器、跨域章节链接、过量并发和超大订阅都会被拒绝。
- 本地 TXT/EPUB 最大 64 MB；EPUB 会在解压前检查正文展开量、单项尺寸和压缩比，防止 ZIP 压缩炸弹。
- 网络发现默认未配置，只有用户主动选择时才会向 Brave 发送搜索词。
- 阅读进度和在线缓存保存在 VS Code 的扩展全局存储目录。
- 浏览器回退使用独立的站点配置目录，不读取日常 Chrome/Edge 配置；普通浏览器缓存回读只检查扩展创建的临时目录和完全匹配的目标 URL，并限制文件、响应及解压后大小。页面脚本只在隔离浏览器进程中执行，返回扩展后仍只提取文本。可随时通过命令清除验证数据。
- 移除本地书籍时，只有明确选择“移除并删除源文件”才会把原文件移入系统回收站。
- 老板键用于快速切换显示内容，不是加密或安全隔离功能。
- 请仅阅读你有权访问的内容，并遵守内容网站的服务条款。

## 本地开发

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
$releaseVersion = node -p "require('./package.json').version"
git add package.json package-lock.json CHANGELOG.md
git commit -m "release: v$releaseVersion"
git tag "v$releaseVersion"
git push origin main
git push origin "v$releaseVersion"
```

GitHub Actions 会校验标签与 `package.json` 版本完全一致，然后自动测试、打包并发布；例如版本 `0.3.3` 必须使用标签 `v0.3.3`。发布凭据保存在仓库的 `VSCE_PAT` Actions Secret 中，不应写入源码。PAT 过期后需要更新 Secret；根据微软公告，全局 Azure DevOps PAT 将于 2026 年 12 月 1 日退役，届时应迁移到 Microsoft Entra ID 发布方式。
