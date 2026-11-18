# luck-mail API 契约（Node 后端 ↔ Vue 前端）

> 后端与前端两个子任务共用此契约。改契约须同步通知对方。
> 基础：同源。Node serve 静态前端（`public/`，即 Vite dist）+ API（`/api/*`）+ Socket.io（`/socket.io/`，实时推送）。
> 所有 API 返回 JSON：成功 `{ok:true, ...}`；失败 `{ok:false, error:"..."}` + 对应 HTTP 状态码。
> 时间统一用 ISO 8601 字符串；ID 一律用 JSON 数字（SQLite 主键）。

## 认证（单用户，Cookie 会话）

- Cookie 名 `lm_session`，httpOnly，SameSite=Lax，Path=/。除下述三个接口外，所有 `/api/*` 与 `/socket.io/` 都必须带有效会话，否则 401。
- `GET /api/auth/status` → `{ok:true, setupRequired:boolean, loggedIn:boolean, username?:string}`
  - `setupRequired=true` 表示还没有任何用户（首次使用），前端显示“创建账号”页。
- `POST /api/auth/setup` `{username, password, confirm}` → 201 `{ok:true}`。
  - 仅当无用户时可用，否则 409。用户名必填（不要邮箱后缀）；密码 ≥8 位；两次一致。失败 5 次锁定 15 分钟（429 + `retryAfter` 秒）。
- `POST /api/auth/login` `{username, password, rememberMe?}` → 200 `{ok:true, username}` + Set-Cookie。错 401；锁定 429。`rememberMe=true` 时建 30 天会话，否则 1 天（不传默认 1 天）。
- `POST /api/auth/logout` → 200，清 Cookie。
- `POST /api/auth/change-password` `{current, next}` → 200。`next` ≥8 位。

## 服务商预设（知名邮箱自动填服务器）

- `GET /api/presets` → `{ok:true, presets:{[domain]:{imapHost,imapPort,imapSecure,smtpHost,smtpPort,smtpSecure,note}}}`，另含 `exmail` 一项（腾讯企业邮箱）。
  - 预设表以 `backend/src/presets.ts` 为准（163/126/yeah/188、Gmail、Outlook/Hotmail、QQ/foxmail、Yahoo、iCloud、AOL、Yandex、Zoho、GMX、mail.com、Fastmail、mail.ru、sina、sohu、139、189、aliyun、naver、heavycrusher.com 等）。
  - `imapSecure` / `smtpSecure` 取值：`SSL`（465/993 直连 TLS）或 `STARTTLS`（587）。
- `GET /api/presets/:domain` → `{ok:true, preset:{...}, note}`；未知域名回落 `{imapHost:"imap."+domain, imapPort:993, imapSecure:"SSL", smtpHost:"smtp."+domain, smtpPort:465, smtpSecure:"SSL", note:"", preset:null}`。

## 邮箱账号

- `GET /api/accounts` → `{ok:true, accounts:[{id, email, displayName, imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure, enabled, sortOrder, status, unreadCount, lastSyncAt, error?}]}`
  - `status`: `online` | `offline` | `error` | `syncing`。**绝不返回密码/授权码。**
- `POST /api/accounts` `{email, password, displayName?, imapHost?, imapPort?, imapSecure?, smtpHost?, smtpPort?, smtpSecure?}` → 201 `{ok:true, account:{...}}`。
  - 未给服务器信息时按域名查预设自动填。保存前必须实测连通：IMAP 登录成功 + SMTP 连通成功，否则 400 `{ok:false, error:"..."}`（说明哪一步失败）。成功后启动该账号同步。
- `PUT /api/accounts/:id` `{displayName?, enabled?, password?, imapHost?, imapPort?, imapSecure?, smtpHost?, smtpPort?, smtpSecure?}` → 200。改了凭据/服务器要重测连通；`enabled=false` 暂停同步并断开连接。
- `DELETE /api/accounts/:id` → 200。删账号及其缓存邮件、文件夹、同步状态，并断开 IMAP。
- `POST /api/accounts/:id/test` → `{ok:true, imapOk:boolean, smtpOk:boolean, error?}`。
- `GET /api/accounts/:id/password` → `{ok:true, password: string}`。取单个邮箱的当前密码（明文）：仅供“邮箱设置”弹窗打开时回填密码框，点小眼睛查看。须登录；平时不随账号列表下发。
- `POST /api/accounts/export` → 200，下载 `luck-mail-accounts-YYYYMMDD-HHmm.xlsx`（`Content-Disposition: attachment`）。导出全部邮箱为 Excel：表头 序号 / 邮箱名 / 授权码 / 接收服务器（IMAP）/ IMAP端口 / 发送服务器（SMTP）/ SMTP端口 / 备注，按当前排序导出；授权码为明文，文件请妥善保存。须登录。**只接受 POST**（GET 会被拒绝：防跨站顶层导航 CSRF 触发下载）。
- `GET /api/accounts/import-template` → 200，下载 `luck-mail-import-template.csv`。导入模板：空的 .csv，只有表头一行（与导出相同的 8 列）。须登录。
- `POST /api/accounts/import` (multipart，字段 `file`，限 5MB) → `{ok:true, added, skipped, failed: [{row, email, reason}], addedEmails, skippedEmails}`。批量导入邮箱：按导入模板的列顺序逐行读（第 1 行是表头）；空行跳过；同名邮箱（不区分大小写、含文件内重复）跳过不报错；格式不对、授权码为空、服务器信息不全（且该域名无自动预设）的行记入 failed，不中断其余行。服务器地址/端口留空时按域名自动取预设。新邮箱直接入库（sort_order 追加到最后，status 'offline'），并启动同步；**导入时不做连通测试**（批量测太慢），加完后可用管理列表每行的“测试”按钮逐个测。须登录。
- `POST /api/accounts/:id/refresh` → 200，触发该账号全量增量同步。
- `POST /api/refresh-all` → 200，触发全部已启用账号同步。

## 文件夹（只列服务器真实文件夹，不造虚拟文件夹）

- `GET /api/accounts/:id/folders` → `{ok:true, folders:[{id, accountId, path, name, type, unreadCount, totalCount}]}`
  - `path` 为 IMAP 原始路径；`name` 为解码后的显示名（如 `已发送`）；`type`: `inbox|sent|drafts|trash|spam|other`，由 IMAP special-use（\Inbox \Sent \Drafts \Trash \Junk）+ 中英文名启发式判定（163：收件箱/草稿箱/已发送/已删除/垃圾邮件）。
  - 文件夹来自 IMAP LIST 同步进 SQLite；列表接口直接读库。

## 邮件

- `GET /api/messages?view=&accountId=&folderId=&q=&limit=50&offset=0` → `{ok:true, messages:[...], total:number}`
  - `view`: `all-inbox` | `all-unread` | `all-sent` | `all-drafts` | `all-trash` | `folder`。
  - `view=folder` 时必须给 `accountId` + `folderId`。`q` 为全文搜索（FTS5，查主题/发件人/正文）。
  - 单条：`{id, accountId, accountEmail, folderId, folderPath, uid, subject, from, fromName, to:[], date, snippet, isRead, hasAttachments, size}`。
  - 列表先只取信封，不含正文。`limit` 默认 50，最大 200。
- `GET /api/messages/:id` → `{ok:true, message:{...同上, cc:[], bodyText, bodyHtml（已消毒）, attachments:[{id, filename, size, contentType}]}}`。打开即标已读（并推 WS 更新）。
- `POST /api/messages/:id/read` `{read:boolean}` → 200（IMAP 标记 + 本地更新 + WS 推送）。
- `POST /api/messages/:id/move` `{folderId}` → 200（IMAP MOVE + 本地更新 + WS 推送）。
- `DELETE /api/messages/:id` → 200。彻底删除与否以后端实际文件夹为准：邮件在已删除文件夹里就是彻底删除（IMAP 标记删除 + expunge + 本地删除），在其他文件夹里就是移到已删除（IMAP MOVE 到 Trash + 本地更新）。客户端 `permanent` 参数已废弃，不再发送。
- `POST /api/messages/batch-delete` → 200，`{ ids: number[], view?: { kind, accountId, folderId } }`，逐封走与单封删除同一语义（移到已删除；邮件已在已删除文件夹里时彻底删除），一次最多 200 封。无 `permanent` 参数——彻底与否以后端实际文件夹为准。`view` 为发起删除的视图，后端记进批量删除任务，刷新后 `delete-status` 靠它恢复“只在该视图显示删除中”。**永远异步返回** `{ ok, taskId, status: 'running' }`（无同步返回），前端轮询 `GET /api/messages/delete-status` 到 running===false，再以状态接口的 `deleted`（数字计数）一次结算 toast。
- `GET /api/messages/delete-status?taskId=` → `{ ok, running, total, deleted, startedAt, view: { kind, accountId, folderId } | null, taskId?, failed?, finishedAt? }`。批量删除任务状态（单进程内存）：任务在跑时前端每 1.5 秒轮询，显示“删除中（剩余数）”；跑完停轮询并刷新列表。`deleted` 为数字计数（已删封数，不是数组）；`total` 为任务总封数；`failed` 为失败明细（有失败时才出现）；`finishedAt` 为任务完成时间（跑完后才有）。`taskId`（可选）：本会话发起的任务传自己的 taskId，避免两标签页同时批量删除时轮询到对方的任务；不传时后端返回最近一个任务（兼容）。`view` 为发起删除的视图，刷新后前端优先用它恢复 deleteView，localStorage 的 `luck-mail-delete-view` 为兜底；两者都没有时按全局 batchDeleting 显示。
- `POST /api/messages/:id/translate` → 200，`{ ok, translated: string, alreadyChinese: boolean }`。正文翻译：英文 → 中文（后端调 DeepL，密钥放服务器 systemd 环境变量 `DEEPL_API_KEY`；免费 Key（`:fx` 结尾）走 `api-free.deepl.com`，付费 Key 走 `api.deepl.com`；未配密钥时报错）。正文取磁盘 `bodies/<id>.txt`（为空时先 fetchFullMessage 再读）；正文已基本是中文时直接返回 `alreadyChinese: true`，不调接口。后端先按段落、再按句子切成 ≤450 字节的小段逐段翻译再拼接。翻译失败返回 502。
- `POST /api/backup/download` → 200，下载 `luck-mail-backup-YYYYMMDD-HHmm.tar.gz`（`Content-Disposition: attachment`）。内容为 `.key` + `data/`（含 luck-mail.db 一致性快照 + bodies/ + attachments/），与迁移指南的恢复布局一致（解压到 /opt/luck-mail 即可恢复）。须登录。**只接受 POST**（GET 会被拒绝：防跨站顶层导航 CSRF 触发下载）。
- `POST /api/messages/send`（multipart/form-data）字段：`accountId`, `to`（逗号分隔）, `cc?`, `bcc?`, `subject`, `text?`, `html?`, `idempotencyKey?`（发信幂等键，字符串，≤128 字符，不校验 UUID 格式；同一封邮件重试复用同一个 key），`draftId?`（发信成功后服务端自动删这条草稿；发信失败草稿保留），文件字段 `attachments`（可多个）。→ 201 `{ok:true, id, messageId, rejected?: string[], warning?: string}`（`rejected` 为被收件方服务器拒收的收件人；`warning` 表示已发出、但未存入已发送文件夹）。发信后把副本 APPEND 到该账号已发送并写库。
  - 也接受无附件的 JSON POST（`Content-Type: application/json`，`to/cc/bcc` 可为数组，同样可带 `idempotencyKey` 与 `draftId`）。
- `GET /api/messages/:id/attachments/:attId` → 附件文件流（带 `Content-Disposition: attachment`），须登录。
- 搜索用 `GET /api/messages?q=`（全文搜索，见上）；账号状态用 `GET /api/accounts`，登录状态用 `GET /api/auth/status`。`GET /api/search` 与 `GET /api/status` 两个旧接口已删除。

## 草稿（服务端，2026-11-18 用户定夺：草稿进数据库，不再写浏览器 localStorage）

- `GET /api/drafts` → `{ok:true, drafts:[{id, accountId, to, subject, text, idempotencyKey, updatedAt}]}`（按 `updatedAt` 倒序）。草稿视图（所有草稿 / 某邮箱草稿箱）直接读这个接口，不调 `/api/messages`；草稿不进 FTS，搜索时不拼进结果。须登录。
- `POST /api/drafts` `{accountId, to, subject, text, idempotencyKey?}` → `{ok:true, draft}`。新建草稿；`idempotencyKey` 缺失时服务端生成。须登录。
- `PUT /api/drafts/:id` `{to?, subject?, text?, accountId?}` → `{ok:true, draft}`。更新草稿内容；`idempotencyKey` 不变。须登录。
- `DELETE /api/drafts/:id` → `{ok:true}`。删草稿。须登录。
- `POST /api/messages/send` 可带 `draftId`：发信成功后服务端自动删草稿，发信失败草稿保留。
- 旧本机草稿一次性迁移：前端 `init` 时若 localStorage 的 `luck-mail-local-drafts` 还有旧草稿，逐条 POST 到 `/api/drafts`（保留原 `idempotencyKey`），全成功后清空旧键；有失败的留在旧键里，下次 `init` 再试。

## 设置

- `GET /api/settings` → `{ok:true, settings:{signature?, defaultAccountId?}}`
- `PUT /api/settings` `{signature?, defaultAccountId?}` → 200。

## Socket.io（实时推送，用户 2026-11-17 00:34 定）

- 前端不直连 IMAP，只与 Node 建一个 Socket.io 连接：服务端 `socket.io`，前端 `socket.io-client`。地址默认 `/socket.io/`（同源）。
- 握手时校验 `lm_session` Cookie（随握手发送；无效则拒绝连接）。
- 服务端 → 客户端事件（JSON payload）：
  - `new-mail` `{accountId, folderId, message:{...信封...}}`
  - `mail-updated` `{messageId, changes:{isRead?, folderId?}}`
  - `mail-deleted` `{messageId}`
  - `sync` `{accountId, folderId?, state:"started"|"done"|"error", error?}`
  - `account` `{action:"added"|"removed"|"updated", account:{...}}`
- 客户端 → 服务端：`ping`（保活即可；Socket.io 自带心跳）。
- 未读数：前端用 Pinia store 的响应式状态 `unreadCounts` 管理，由上述事件驱动更新；左侧导航树红色角标绑定 `unreadCounts`，即时亮起；不要轮询、不要整页刷新。

## 前端页面（Vue）

- `/` 主界面（3 栏），未登录跳 `/login`。
- `/login` 登录卡片（干净白卡片样式，用户名+密码带小眼睛+30天免登录+蓝色按钮，见 image-111）；`setupRequired` 时显示创建账号（用户名/密码/确认密码，同一样式）。
- 加邮箱：Foxmail 式弹窗（邮箱+密码+接收/SMTP 服务器+SSL+端口+STARTTLS，底部返回/创建/取消），域名输入后按预设自动填服务器，创建前调 `POST /api/accounts/:id/test` 或直接创建（创建接口自带连通验证）。
- 邮箱管理：弹窗表格（邮箱/备注名 inline 改/排序/操作=邮箱设置、临时停用、删除邮箱；+ 添加邮箱；数量显示；确定/取消），样式与主界面统一。
- 设置：改密码、默认账号、签名（弹窗或独立页，样式与主界面统一）。
- 主界面功能与外观与现有原生版一致：聚合分类（所有收件箱/所有未读/所有草稿/所有已发送/所有已删除）、邮箱平铺无分组、邮箱可展开文件夹、写信弹窗、全部刷新按钮、配色切换（6 色，localStorage）、响应式（桌面 3 栏/平板收窄栏/手机单栏钻取）。
- 实时：Socket.io（`socket.io-client`，单连接）接 new-mail/mail-updated/mail-deleted/sync 事件，列表实时更新；未读数走 Pinia 响应式状态 `unreadCounts`，由事件驱动更新，左侧导航树红色角标即时亮起；不要轮询、不要整页刷新。
- Pinia 全局状态 `useMailStore`（用户 2026-11-17 00:37 定）：`accounts`（多邮箱基本信息与连接状态）、`activeAccountId` / `activeFolder`（当前点的左栏邮箱与文件夹）、`mailList`（缓存当前列表邮件，避免频繁请求 Node）、`unreadCounts`（响应式 Map，实时统计各账号未读角标）。状态同步：删信、标已读/未读、收新邮件时，`unreadCounts` 与 `mailList`、左侧角标一起即时更新，不要整页刷新、不要重新拉全量。

## 后端实现要点（用户 2026-11-17 00:38 定）

1. 纯流式处理：不要把整封邮件下载到内存再丢给解析器。用 imapflow 的流式下载能力，配合 mailparser 的流式解析，附件只记元信息（文件名、大小、类型、IMAP part 号）存进 SQLite、内容流直接丢弃，不写入磁盘，避免撑爆内存。
2. Worker Threads：如果邮件正文非常大，把 mailparser 的解析任务扔到 Node.js 的 `worker_threads` 里执行，让主线程专心维护 IMAP 长连接和响应前端 API。
3. SQLite 开 WAL 模式：连接 SQLite 时务必执行 `PRAGMA journal_mode=WAL;`，开启写前日志，实现读写并发，防止收邮件写库时阻塞前端读库。

## 附件处理（用户 2026-11-17 10:51 定：默认不下载任何附件）

- 所有附件（不分大小）默认不下载、不存本项目服务器：收信/发信时只把元信息（文件名、大小、类型、IMAP part 号）存进 SQLite，内容流直接丢弃。
- 用户点下载时，后端凭 part 号从 IMAP 实时取、流式传给浏览器，全程不落盘。已发附件的 part 号在发信 APPEND 进已发送后取 BODYSTRUCTURE 匹配文件名得到。
- 发信时上传的附件先落盘再发：multer diskStorage，文件写 `os.tmpdir()` 下的临时目录，单文件 ≤25MB、一次最多 10 个、总计 ≤50MB；发完（成功或失败）即清理，不留盘；附件本体只存在邮件服务器的已发送文件夹里。
- 前端：附件旁边显示大小；不再分“较大”/普通，样式统一，悬停提示“点击下载：从邮箱服务器实时取”。
- 历史遗留：2026-11-17 10:51 之前已缓存到磁盘的旧附件文件保留在原处（旧已发附件的 part 为 NULL，下载仍走磁盘缓存）；此后不再产生新的缓存文件，磁盘占用不再增长。

## 技术栈与规模（用户 2026-11-17 00:42 定，规模定稿）

- 规模：最多 50 个邮箱。单 Node 进程 + SQLite（WAL + FTS5）即最优解。不要分布式微服务、集群调度、Redis、PostgreSQL、S3/MinIO、Elasticsearch/Meilisearch、离线降级轮询（50 个邮箱全挂 IDLE）、前端 Web Worker。
- 前端：Vue 3 + Vite + TypeScript（严格类型）+ Pinia + Tailwind CSS（复用现有浅蓝色 3 栏布局类名）+ socket.io-client。
- 后端：Express 或 Fastify 模块化架构 + TypeScript，不用 NestJS。
- 虚拟滚动：只给邮件列表用（MailList.vue）；账号树最多 50 个，直接 v-for。
- 懒加载：Pinia 不预存全部目录树；导航树初始化只加载一级账号名，点某个邮箱的折叠箭头时才向后端要该账号的文件夹结构（`GET /api/accounts/:id/folders`）。
- 流式解析：严禁把邮件正文读入内存；imapflow 流式拉取 → stream.pipeline → mailparser 流式解析 → 附件只记元信息（不写磁盘）；大正文解析扔 worker_threads；数据库主表只存标题、发件人、附件元数据等（洗净后的 HTML 正文存磁盘文件，SQLite 存其路径；FTS5 索引存可搜索文本以支持全文搜索）。
- 消毒：所有存盘的 HTML 正文经服务端 DOMPurify（JSDOM）严格清洗，去脚本与追踪像素；前端 MailViewer 用沙盒 iframe（srcdoc 属性）渲染洗净后的 HTML，保证主应用安全、浅蓝色 UI 不被邮件内 CSS 覆盖。
- 数据流：imapflow.on('exists') → 流式拉 Header → 写 SQLite → Socket.io 推给 Vue → Pinia 更新 unreadCounts → 左栏红点亮起；点邮件读信走 `GET /api/messages/:id`，从 SQLite 取元数据、从磁盘取洗净后的 HTML 与附件列表。
