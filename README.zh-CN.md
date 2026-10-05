# free-search-mcp-ts

**本地优先、无需 API key 的 MCP 联网搜索、网页抓取与文档解析服务器。**

> **来源说明。** 这是同一想法的独立 **TypeScript** 实现。更成熟的原版是 **Python** 项目
> [sweetcornna/free-search-mcp](https://github.com/sweetcornna/free-search-mcp),以 `free-search-mcp` 之名发布在 PyPI 上。
> 两者是不同作者、互不相关的代码库:本项目不是它的 fork,也不宣称与它功能对等。

`free-search-mcp-ts` 是一个 [Model Context Protocol](https://modelcontextprotocol.io) 服务器,为 Claude、GPT、Cursor、Codex、本地 Ollama 前端以及任何支持 MCP 的客户端提供联网搜索、网页读取和文档解析能力。它完全在你自己的机器上运行,不需要注册任何账号,并且返回 Markdown 而不是 JSON —— 因为承载同样的信息,Markdown 大约能省下三分之一 token。

**尚未发布到 npm。** `npx -y free-search-mcp-ts` 要等包发布后才能用;在那之前请走[快速开始](#快速开始),四条命令即可在本地构建。

[![CI](https://github.com/lhswgzy/free-search-mcp-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/lhswgzy/free-search-mcp-ts/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen.svg)](https://nodejs.org)

---

## 为什么做这个

让模型「去查一下」通常只有三条路:买搜索 API、给它一个它开不动的浏览器、或者手动贴 URL。对本地模型来说这三条都不好用,而且没有一条能让你的查询留在本机。

这个项目换了个思路:

- **默认不需要任何密钥。** DuckDuckGo、Mojeek、Google News 直接走公开接口,不用注册,也就没有 key 可泄漏。
- **多引擎而不是单源。** 所有引擎的结果用 RRF(互惠排序融合)合并,三个引擎都独立命中的页面会排在只有一个引擎命中的页面之前 —— 稳定性远好于任何单一来源。
- **降级而不是报错。** 被墙、被限流、连不上的引擎会被识别并「罚下场」,由下一层引擎接管。在过滤了部分服务商的网络里它照样能用:默认兜底层里就有引擎是专门为这种情况选的。
- **数据不出本机。** 查询发给你选定的搜索引擎;你读过的页面存在本机的 SQLite 索引里,除此之外不上传任何东西。没有遥测。
- **Markdown 优先。** 输出是模型能直接读的标题 + 列表结构。实测十结果搜索:Markdown 形式比等价 JSON **少 32% token**([见实测数据](#实测而非声称))。

## 快速开始

下面这条路今天就能用,不需要等 npm 发布:它从源码构建,并把 `free-search-mcp-ts` 链接进 PATH。

```bash
git clone https://github.com/lhswgzy/free-search-mcp-ts
cd free-search-mcp-ts
npm install && npm run build && npm link
free-search-mcp-ts install
```

这条命令会把服务器注册到本机已存在的 MCP 客户端。然后检查引擎与网络,并直接试一次:

```bash
free-search-mcp-ts doctor
free-search-mcp-ts search "模型上下文协议 MCP 是什么"
free-search-mcp-ts research "reciprocal rank fusion 原理" --depth 2
```

之后重启客户端即可。想先看看安装器会改哪些文件:`free-search-mcp-ts install --dry-run` 只打印计划,不写入任何内容。

### 发布到 npm 之后

`npx -y free-search-mcp-ts` 是不想本地 clone 的用户的正式路径,但包目前还没发布到 npm。发布之后,上面的命令都可以换成:

```bash
npx -y free-search-mcp-ts install
npx -y free-search-mcp-ts doctor
npx -y free-search-mcp-ts search "模型上下文协议 MCP 是什么"
npx -y free-search-mcp-ts install --dry-run
```

## 暴露给模型的工具

| 工具 | 作用 |
|------|------|
| **`web_search`** | 同时查询多个引擎,RRF 融合、去重、重排序。还不知道答案在哪个页面时用它。 |
| **`research`** | 一次调用完成整条链路:搜索 → 依据首屏结果实际用词派生子查询 → 抓取最相关且来源多样的网页 → 抽取真正回答问题的段落。返回带编号出处的 Markdown 简报。 |
| **`fetch_url`** | 抓取单个网页或文档并转成干净的 Markdown。支持 HTML、PDF、DOCX、XLSX、PPTX、EPUB、ODT、CSV、JSON 和纯文本。超长文档会截断并给出续读偏移,而不是拒绝返回。 |
| **`fetch_urls`** | 并发抓取最多 12 个 URL,逐个报告失败原因。 |
| **`parse_document`** | 解析本地文件或远程文档:表格变 Markdown 表格,演示文稿每页一节,DOCX 保留标题、列表和表格。 |
| **`search_index`** | 对本机已抓取的全部内容做全文检索,底层是带中日韩 bigram 支持的 SQLite FTS5 索引。不产生任何网络请求。 |
| **`local_index`** | 查看、清理、修剪或压缩该本地索引。 |
| **`list_engines`** | 列出全部引擎及其层级、是否需要密钥、当前健康状况。 |

所有工具都支持 `format: "json"`,供需要后处理的调用方使用。

## 引擎

共 24 个引擎,分层调度。层级决定它何时运行;你也可以用 `engines: ["bing", "wikipedia"]` 指定,或 `engines: ["all"]` 全部启用。

### 主层 —— 文档中承诺的无密钥默认组合

| 引擎 | 说明 |
|------|------|
| `duckduckgo` | HTML 接口,失败时自动回退到 lite 接口;支持地区、时间范围与安全搜索参数。 |
| `mojeek` | 拥有独立爬虫和索引,是摆脱 Bing/Google 双寡头的一条路。 |
| `googlenews` | Google News RSS:是新闻文章源而非通用网页索引,支持 `when:` 时间算子。 |

### 兜底层 —— 主层结果不足时自动启用

| 引擎 | 说明 |
|------|------|
| `bing` | 无密钥 HTML。在 DuckDuckGo 和 Google 不可达的网络里仍然可用,因此作为全局兜底。 |
| `baidu`、`sogou`、`so360` | 中文引擎,CJK 查询或显式 `region: "cn"` 时启用。它们的跳转包装链接会在本地解码。 |

### 专题索引 —— 依据查询自动选择

`wikipedia`、`hackernews`、`github`、`stackexchange`、`arxiv`、`openalex`、`crossref`、`npm`、`crates`

问一个 Rust crate 的问题会顺带查 crates.io;查询里带报错信息会顺带查 Stack Overflow。触发词表就在 [`src/engines/registry.ts`](src/engines/registry.ts),是可直接阅读的正则。

### 可选与付费

| 引擎 | 说明 |
|------|------|
| `startpage`、`brave` | 无密钥 HTML 前端。经常遇到同意页或反爬墙,这类情况会被识别为「被拦截」而不是「没有结果」。 |
| `searxng` | 用 `SEARXNG_URL` 指向你自己的实例。支持逗号分隔的多个实例并自动故障转移。 |
| `brave-api`、`serper`、`tavily`、`exa`、`google-cse` | 可选的密钥引擎。配置了密钥后会加入第一层并获得更高的 RRF 权重 —— 有文档的 JSON API 终究比抓 HTML 可靠。 |

```bash
BRAVE_API_KEY=... npx -y free-search-mcp-ts search "..."      # 也支持 SERPER_API_KEY / TAVILY_API_KEY / EXA_API_KEY
SEARXNG_URL=https://searx.example.org npx -y free-search-mcp-ts search "..."
```

## 工作原理

**互惠排序融合(RRF)。** 每个引擎为它返回的每个文档贡献 `1 / (k + rank)`,并叠加引擎权重与「多引擎共识」加成。RRF 不需要在不同服务商之间做分数对齐 —— 这一点很关键,因为 Bing 的相关度分、Mojeek 的 BM25 分和 Google News 的发布时间序根本不是同一量纲。见 [`src/rrf.ts`](src/rrf.ts)。

**分层升级。** 先跑主层;只有结果数低于阈值才跑兜底层;再不够才跑与查询匹配的专题索引。主层能答的查询只花两三个请求;被过滤的网络里依然能出结果。

**能跨进程存活的熔断器。** 明确拒绝我们(403/429/验证码)的服务商一次即被罚下场 10 分钟;连 TCP 都建立不起来的服务商罚 5 分钟。这些状态写进本机 SQLite,所以重启服务器 —— 或者你下一次跑命令行 —— 不会再把超时重付一遍。

**跳转包装在本地解码。** 百度、搜狗、360、DuckDuckGo、Bing 都会返回 `/link?url=` 或 `/ck/a?u=` 形式的包装链接。这些在本地解码,同时改善了引用质量和跨引擎去重;只有解不开的包装才需要真正跟一次跳转。

**本地全文索引。** 每个抓到的页面都存进 SQLite,并对标题和正文建 FTS5 索引。中文在入索引时会展开成重叠 bigram —— 否则 `unicode61` 会把整句中文当成一个 token,导致中文完全搜不到。

**Markdown 抽取。** linkedom 解析,Mozilla Readability 提取正文,Turndown 输出 GitHub 风格 Markdown —— 标题、列表、表格、带语言标记的代码块、绝对链接。当 Readability 拒绝一篇页面(更新日志、规范文档、表格密集的文档站)时,回退方案会保守地剥掉页面框架,而不是直接放弃。

## 实测,而非声称

| 说法 | 实测 |
|------|------|
| Markdown 比 JSON 省 token | 十结果搜索:Markdown **3,752 字符 / 约 938 token**,等价 JSON **5,550 字符 / 约 1,388 token** —— **少 32%**。 |
| 抓网页返回的内容远小于原始 HTML | MDN 的 Fetch API 页面:150 kB HTML → **5.4 kB** Markdown(小 **96%**,约 38,300 → 约 1,378 token)。Bing 和百度结果页分别为 97% 和 99%。 |
| 熔断器确实值回票价 | 在 DuckDuckGo 和 Google News 不可达的网络里:第一次搜索 **11.9 秒**,之后 **1.3 秒**,因为死掉的引擎已被罚下场。 |

前两项可用 `npx tsx scripts/measure-savings.mts` 复现;第三项连续跑两次 `free-search-mcp-ts search` 即可。

## 客户端

`free-search-mcp-ts install` 会探测并写入以下客户端。**只会动配置文件已存在的客户端**,每次写入前都会生成 `.bak` 备份,且只修改属于本服务器的那一个键。

| 客户端 | 配置文件 |
|--------|----------|
| Claude Desktop | `claude_desktop_config.json` |
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| VS Code(Copilot agent 模式) | `.vscode/mcp.json` 或用户配置 |
| Cline | `cline_mcp_settings.json` |
| Roo Code | `mcp_settings.json` |
| Zed | `settings.json`(`context_servers`) |
| Codex CLI | `~/.codex/config.toml` |
| Gemini CLI | `~/.gemini/settings.json` |
| opencode | `~/.config/opencode/opencode.json` |
| LM Studio | `~/.lmstudio/mcp.json` |
| Continue | `~/.continue/config.json` |

```bash
npx -y free-search-mcp-ts clients                          # 查看全部支持的客户端 id
npx -y free-search-mcp-ts install --client cursor --dry-run
npx -y free-search-mcp-ts install --client claude-desktop,codex
npx -y free-search-mcp-ts uninstall --client cursor
```

**Ollama 本身不支持 MCP。** 工具调用循环必须在客户端里,所以正确做法是让支持 MCP 的前端连上本服务器 —— 用 HTTP 方式跑起来,然后在 Open WebUI、LibreChat 等界面里添加:

```bash
free-search-mcp-ts serve --transport http --port 8765
# 然后添加 http://127.0.0.1:8765/mcp 作为 streamable-HTTP MCP 服务器
```

## 命令行

```
free-search-mcp-ts                     # 以 stdio 提供 MCP 服务(客户端启动的就是它)
free-search-mcp-ts install             # 注册到本机探测到的客户端
free-search-mcp-ts uninstall           # 取消注册
free-search-mcp-ts doctor              # 检查网络、每个引擎和本地索引
free-search-mcp-ts search  "<查询>"     # 多引擎搜索
free-search-mcp-ts research "<问题>"    # 搜索 + 阅读 + 抽取,输出带出处的简报
free-search-mcp-ts fetch   <url>       # 单页或文档转 Markdown
free-search-mcp-ts parse   <文件>       # 本地文档转 Markdown
free-search-mcp-ts engines [--check]   # 引擎列表、层级与健康状态
free-search-mcp-ts cache   <stats|search|clear|prune|vacuum|path>
free-search-mcp-ts config              # 当前生效的配置
free-search-mcp-ts tools [--json]      # MCP 工具清单
free-search-mcp-ts clients             # 支持的客户端 id
```

常用参数:`--json`、`--max <n>`、`--engines a,b`、`--freshness day|week|month|year`、`--lang`、`--region`、`--depth 1-3`、`--sources <n>`、`--data-dir <路径>`、`--verbose`。

这些子命令调用的是 MCP 服务器注册的同一批 handler,所以 `free-search-mcp-ts search "…"` 是模型实际会拿到什么的真实端到端测试。

## 配置

全部可选。把 [`.env.example`](.env.example) 复制成 `~/.free-search-mcp/.env` 即可,或在客户端的 `env` 块里设置。

| 变量 | 默认值 | 作用 |
|------|--------|------|
| `FREE_SEARCH_ENGINES` | `auto` | 逗号分隔的引擎 id,或 `auto` 走分层策略。 |
| `FREE_SEARCH_MAX_RESULTS` | `12` | 默认结果数。 |
| `FREE_SEARCH_TIMEOUT` | `15000` | 单请求超时(毫秒)。 |
| `FREE_SEARCH_CACHE` | `1` | 设为 `0` 关闭本地 SQLite 索引。 |
| `FREE_SEARCH_CACHE_TTL_HOURS` | `24` | 抓取页面的保鲜时长。 |
| `FREE_SEARCH_PROXY` | — | HTTP(S) 代理,如 `http://127.0.0.1:7890`。也识别标准的 `HTTPS_PROXY`。 |
| `FREE_SEARCH_RESPECT_ROBOTS` | `1` | 设为 `0` 时抓取忽略 robots.txt。 |
| `FREE_SEARCH_ALLOW_PRIVATE` | `0` | 设为 `1` 才允许访问回环/内网地址(默认关闭,作为 SSRF 防护)。 |
| `FREE_SEARCH_REGION`、`FREE_SEARCH_LANGUAGE` | — | 地区与语言提示,如 `us`/`en`、`cn`/`zh`。 |
| `FREE_SEARCH_DATA_DIR` | `~/.free-search-mcp` | 索引与配置所在目录。 |
| `FREE_SEARCH_LOG_LEVEL` | `warn` | `silent`、`error`、`warn`、`info`、`debug`。 |

`~/.free-search-mcp/config.json` 支持同样的配置项,键名用 camelCase。

### 代理与受限网络

在开放网络上开箱即用。如果你的网络过滤了部分服务商,可以挂代理:

```bash
FREE_SEARCH_PROXY=http://127.0.0.1:7890 free-search-mcp-ts search "..."
```

也可以什么都不做,交给分层兜底 —— 兜底层里的引擎正是为「DuckDuckGo 和 Google 不可达」这种网络选的。`free-search-mcp-ts doctor` 会逐个引擎实测并打印结果,让你清楚看到当前网络下哪些能用。

## 安全与隐私

- **除了你的搜索词和你要求抓取的页面,没有任何东西离开本机。** 没有遥测,没有统计,没有服务端组件。
- **`fetch_url` 由模型驱动,因此设了防护:** 默认拒绝回环、链路本地和私有网段地址;确实需要读本地服务时再设 `FREE_SEARCH_ALLOW_PRIVATE=1`。
- **默认遵守 robots.txt**,被禁止的路径会明确报告出来,而不是静默跳过。
- **本地文件访问受限**:仅限 100 MB 以内的普通文件,且只能通过显式的 `parse_document` 工具。
- **stdout 上只写 JSON-RPC。** 所有诊断信息走 stderr,因此一行跑偏的日志永远不会污染协议流。

## 运行要求

- **Node.js 20.19+** 即可运行。
- **Node.js 22.5+**(推荐 24+)才能使用本地 SQLite 索引,它基于内置的 `node:sqlite`。在更老的运行时上缓存会降级为进程内 LRU,其余功能不受影响 —— `doctor` 会告诉你当前用的是哪种后端。
- 没有原生模块,不需要编译器,没有安装后构建步骤。

## 验证状态

把「测过什么」说清楚,比堆功能列表重要。

- **在本机真实网络上验证过:** Bing、百度、搜狗、360、Hacker News(Algolia)、GitHub、Stack Exchange、npm、crates.io、OpenAlex、Crossref,以及完整的「抓取 → Markdown → 入索引 → 再读取」链路。`doctor` 的引擎实测和命令行子命令都跑通了,MCP 服务器完成了 17 项协议握手检查(`initialize`、`tools/list`、`tools/call`、`ping`)。
- **用真实抓取响应验证过:** arXiv,以及上面列出的每一个引擎。
- **仅用 fixture 验证**(本机网络无法访问):DuckDuckGo、Mojeek、Google News、Startpage、Brave、SearXNG、Wikipedia。它们的解析器、参数映射和错误路径都有测试覆盖,测试基于公开的标记结构与 API 形状编写,但**没有**用真实响应跑过。如果这几个里有谁在你那边表现异常,这是最可能出问题的地方 —— 附上原始响应的 issue 是修得最快的。
- **完全未验证:** 5 个密钥引擎的真实响应(本机没有 key)。它们的请求构造与响应映射已用 fixture 离线验证。

## 开发

```bash
git clone https://github.com/lhswgzy/free-search-mcp-ts
cd free-search-mcp-ts
npm install
npm run build          # tsc -> dist/
npm test               # vitest
npm run typecheck
node dist/cli.js doctor
```

目录结构:

```
src/
  cli.ts            命令行,以及 stdio/HTTP 入口
  server.ts         MCP 服务器、工具注册、两种传输
  search.ts         分层调度、RRF、包装链接解码
  research.ts       搜索 -> 抓取 -> 段落抽取
  rrf.ts            互惠排序融合与去重
  cache.ts          SQLite FTS5 页面索引与熔断状态
  http.ts           代理、重试、体积上限、SSRF 防护
  robots.ts         robots.txt 解析与缓存
  config.ts         默认值 <- config.json <- .env <- 环境变量
  html/markdown.ts  HTML -> Markdown 流水线
  fetch/page.ts     抓取与转换服务
  fetch/documents.ts PDF、DOCX、XLSX、PPTX、EPUB、ODT、CSV、JSON
  engines/          每个引擎一个文件,外加 kit.ts 与 registry.ts
  install/          客户端规格与安装器
  tools/            工具 schema、handler 与 Markdown 渲染
tests/              vitest 测试与引擎 fixture
```

新增一个引擎 = 一个文件 + 在 [`src/engines/registry.ts`](src/engines/registry.ts) 加一行。每个引擎自己声明层级、RRF 权重,以及(专题索引的)生效查询特征。

## 已知局限

- **`research()` 是引用,不是摘要。** 本服务器自身没有语言模型,所以简报在设计上就是抽取式的:它挑出与查询匹配的段落并逐条标注可引用来源,由调用它的模型来完成综述。把这一步叫做「摘要」是不诚实的。
- **HTML 抓取天然脆弱。** 引擎会改版。结构化兜底抽取器不依赖选择器,能适应一部分变化;某个引擎挂掉时它会降级为零结果并被罚下场,而不是让整次搜索失败 —— 但服务商改版仍然可能快过一次发版周期。
- **专题索引按设计就是窄的。** Wikipedia、GitHub、crates.io、arXiv 索引的是特定语料,不是整个互联网。
- **不支持 OCR。** 扫描版 PDF 会明确报告「无可提取文本」,而不是静默返回空。

## 许可证

MIT,见 [LICENSE](LICENSE)。

---

如果它帮你省下了一笔搜索 API 账单,欢迎点个 star。带原始引擎响应的 issue 是最有用的一类反馈。
