# Security Policy

## Supported version

安全修复只保证进入最新发布版本。使用旧版时，请先升级到 VS Code Marketplace 中的最新版。

## Reporting a vulnerability

请不要在公开 Issue 中披露尚未修复的漏洞、利用代码、访问令牌或隐私数据。优先使用 GitHub 的 [Private vulnerability reporting](https://github.com/xiaoyangxea/code-novel-reader/security/advisories/new) 私下报告，并提供：

- 受影响版本和操作系统；
- 可重复的最小步骤或测试文件；
- 预期影响，以及是否涉及 SSRF、任意文件操作、凭据泄露或资源耗尽；
- 如有可能，提供不包含真实密钥和个人数据的日志。

## Security boundaries

- 自定义书源是声明式 JSON，不执行 JavaScript、命令或远程插件。
- 网络请求仅允许 HTTP/HTTPS 公网目标，并在每次重定向后重新验证和固定解析地址。
- Brave API Key 只保存在 VS Code `SecretStorage`，不会进入书源、设置、日志或导出文件。
- 网络正文、订阅、目录规模、搜索并发和本地 EPUB 解压均有资源上限。
- 浏览器回退使用按站点隔离的数据目录，不读取日常浏览器配置；浏览器可执行文件只接受用户全局设置，并阻止常见本机/私网主机名。
- 普通浏览器缓存回读只访问扩展为当前请求创建的临时目录，要求缓存键与目标 URL 完全匹配，并对索引、地址、文件范围、压缩数据和解压结果设置硬上限。
- 人机验证窗口只在用户确认后打开，验证数据可通过“代码小说: 清除专用浏览器数据”删除。
- 插件不绕过登录、验证码、付费限制或网站访问控制。

安全限制不能替代来源可信度判断。只导入你信任且有权访问的书源和内容。
