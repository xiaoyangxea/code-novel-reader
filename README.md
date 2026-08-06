# Code Novel Reader - 代码小说阅读器

[从 VS Code Marketplace 安装](https://marketplace.visualstudio.com/items?itemName=xiaoyangxea.code-novel-reader) · [查看最新版本](https://github.com/xiaoyangxea/code-novel-reader/releases/latest) · [反馈问题](https://github.com/xiaoyangxea/code-novel-reader/issues)

把在线或本地小说显示为 VS Code 原生 TypeScript 文档中的 `//` 注释。阅读页面不是 Webview，语法高亮、滚动条、标签页和普通代码文件一致。

这是一个给开发者摸鱼看小说的小工具：正文伪装成 TypeScript 注释，页面外观和普通代码文件几乎一样，不需要在编辑器与浏览器之间来回切换；遇到有人靠近时，还可以用老板键立即把小说内容替换成正常的诊断代码。

## 功能

- 在线搜索：内置蚂蚁文学、纵横中文网和维基文库搜索，并可在设置中添加兼容的 HTML 搜索入口。
- URL 导入：支持书籍目录页或任意章节 URL；识别后弹出可搜索的完整章节列表。
- 通用网页解析：专用 CSS 规则优先，正文密度算法兜底；自动识别标题、目录、正文、上一章和下一章，并清理常见隐藏反采集文本。
- 本地阅读：支持 TXT、Markdown、TEXT 和 EPUB；自动识别 UTF-8、GBK/GB18030、UTF-16LE。
- TypeScript 伪装：正文以 `//` 注释混入诊断代码模板。
- 翻页与翻章：编辑器按钮会根据当前位置自动显示“上一页/下一页”或“上一章/下一章”，章节末尾继续翻页会自动进入下一章。
- 老板键：立即用正常 TypeScript 诊断管线替换全部阅读内容。
- 进度与缓存：逐页保存进度，在线章节抓取后本地缓存。
- 书架清理：移除本地书籍时可同时将 TXT/EPUB 源文件移入系统回收站；移除在线书籍会清理章节缓存。
- 可扩展搜索源：添加搜索 URL 后，使用通用表格/列表解析器提取结果。

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
- 点击书架中的书名继续阅读。

URL 导入完成后会弹出可搜索的章节目录。编辑器右上角的左右按钮会根据当前位置显示“上一页/下一页”，到章节边界时自动切换为“上一章/下一章”。

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
| 纵横中文网 | 是 | 是 | 是，已验证搜索、目录和公开章节 |
| 维基文库 | 是 | 是 | 是 |
| 69书吧 | 否 | 是 | 是；遇到 Cloudflare 验证时会明确停止 |
| 17K小说网 | 否 | 是 | 是；仅限可直接访问的公开页面 |
| 晋江文学城 | 否 | 是 | 是；不读取锁定或登录章节 |
| 起点中文网 | 否 | 是 | 公开章节规则，不处理付费或登录内容 |

此外还保留笔趣阁类静态模板和未知站点的通用正文密度识别。网站结构可能随时变化；表格表示扩展包含对应解析规则，并不保证站点始终可访问。通用模式会尝试常见的正文、目录、标题及上下章结构，但无法保证所有页面都能解析。

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

如果提示 HTTP 521、连接超时或人机验证，通常表示源站/CDN 暂时不可用、代理配置有误，或页面要求浏览器验证；这类错误与网页结构识别失败不同。扩展不会绕过验证码、登录或付费限制。

## 添加搜索源

在 `settings.json` 中加入搜索入口，`{keyword}` 会替换为 URL 编码后的搜索词：

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
- 在线导入仅请求用户选择的公开页面及其章节链接。
- 阅读进度和在线缓存保存在 VS Code 的扩展全局存储目录。
- 移除本地书籍时，只有明确选择“移除并删除源文件”才会把原文件移入系统回收站。
- 老板键用于快速切换显示内容，不是加密或安全隔离功能。
- 请仅阅读你有权访问的内容，并遵守内容网站的服务条款。

## 本地开发

```powershell
npm ci
npm run check
npm test
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
