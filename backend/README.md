# luck-mail 后端（Node.js + TypeScript）

单 Node 进程 + SQLite（WAL + FTS5），服务最多 50 个邮箱。Express 模块化架构 +
TypeScript（`tsconfig` 开 `strict`），不用 NestJS；实时推送用 Socket.io；
收信 imapflow（IDLE + UID/MODSEQ 增量同步），发信 Nodemailer，解析 mailparser，
消毒 DOMPurify（JSDOM）。契约见 `../API_CONTRACT.md`（后端与前端共用）。

## 文件清单

```
backend/
  package.json            依赖与脚本（build / start / verify）
  tsconfig.json           strict: true，module NodeNext，outDir dist/
  src/
    server.ts             入口：Express + Socket.io + 静态前端 + 优雅停机
    config.ts             环境变量、目录、主密钥（.key 0600）、阈值常量
    db.ts                 SQLite schema（WAL）、FTS5 trigram、body 文件读写
    cryptoUtil.ts         scrypt 密码哈希、AES-256-GCM 账号密码加密
    auth.ts               会话 Cookie（`lm_session`，`COOKIE_SECURE=1` 时为 `__Host-lm_session`）、5 次锁定 15 分钟
    presets.ts            服务商预设表（另含 exmail）
    sanitize.ts           DOMPurify（JSDOM）：去脚本/事件属性/1x1 追踪像素
    mailUtil.ts           文件夹类型判定、BODYSTRUCTURE 附件 part
    mailStream.ts         流式解析：MailParser 流 + 附件元数据（不落盘）
    streamParse.ts        大正文路由：超阈值先落临时文件再扔 worker 解析
    parseWorker.ts        worker_threads 解析入口（只收文件路径，不收大 Buffer）
    imapUtil.ts           IMAP ID（RFC 2971）、连通测试、SMTP transporter 构造
    smtpUtil.ts           Nodemailer 发送 + MIME 原始报文（APPEND 到已发送）
    idempotency.ts        发信/删信幂等占位（claimSendKey、delete claim）
    engine.ts             同步引擎：每账号一连接、IDLE、增量同步、读写删移、附件实时流
    hub.ts                Socket.io 广播（new-mail / mail-updated / mail-deleted / sync / account）
    routes/
      authRoutes.ts       status / setup / login / logout / change-password
      accountRoutes.ts    presets / accounts CRUD / test / refresh / folders
      messageRoutes.ts    列表 / 详情 / 标已读 / 移动 / 删除 / 发信 / 附件下载 / 搜索
      draftRoutes.ts      服务端草稿 CRUD（POST / PUT / DELETE / GET 分页）
      miscRoutes.ts       settings（签名、默认账号）
  scripts/
    verify-all.mjs        本地全量验证脚本（见下）
  public/                 Vite dist 产物放这里（集成时；本地没有时 serve 占位页）
  data/                   默认 DATA_DIR（git 忽略）：luck-mail.db、.key、bodies/（.key 在 data/ 里是 KEY_FILE 默认 ./data/.key 的前提；KEY_FILE 另指别处时 .key 不在 data/ 里）
  dist/                   tsc 编译产物（git 忽略），跑 node dist/server.js
```

## 启动方式

```bash
cd backend
npm ci
npm run build        # tsc -> dist/
npm start            # node dist/server.js
```

环境变量：`PORT`（默认 8080）、`DATA_DIR`（默认 `./data`）、`KEY_FILE`
（默认 `./data/.key`）、`PUBLIC_DIR`（默认 `./public`）、
`COOKIE_SECURE=1`（生产经 HTTPS 时开启 Secure Cookie）、
`MAIL_PARSE_WORKER_THRESHOLD_BYTES`（默认 5MB）、
`DEEPL_API_KEY`（正文翻译用 DeepL 密钥；不配则翻译报错）。

首次启动会自动建 `data/`、生成 32 字节主密钥 `.key`（权限 0600）、建库开 WAL。
`PUBLIC_DIR` 里没有 `index.html` 时，`/` 返回占位页说明后端已跑起来，不报错退出。

## 首次建账号（一次性引导凭证）

全新部署或删库重建后，`users` 表为空，首次启动时后端生成一个一次性引导 token：

- token 写进数据目录的 `.setup-token` 文件（权限 0600），同时打到启动日志：`[setup] first-run bootstrap token: <token> （also in DATA_DIR/.setup-token; deleted after the first user is created)`；
- 登录页显示“创建管理员账号”时，须在“引导凭证”一栏填入该 token，再填用户名/密码提交（`POST /api/auth/setup` 带 `setupToken` 字段）；
- token 不对或缺失时后端返回 403；建成首个用户后 token 文件自动删除，该栏不再出现；token 猜错会计入 IP 锁定（5 次失败锁 15 分钟，锁检查在 token 校验之前，审计 #12 L5）；
- 重启后、首个用户建成前，token 仍然有效（文件还在就沿用，不重新生成）；已建过用户时 `POST /api/auth/setup` 直接返回 409。

## 验证结果（本地，`npm run verify`）

验证脚本 `scripts/verify-all.mjs`：在临时 `DATA_DIR` 上起编译后的服务器，
断言总数见最近一次 `node scripts/verify-all.mjs` 的输出（以 0 失败为准；
审计 #17 D1 起不再在文档里写死通过数——每次加断言都会让硬数字过期。
分支内断言按实际执行路径计入——import18b 的端到端断言与回退分支互斥，
一次运行只走其中一条）。

注意：并非全程只用假账号——第 7 节账号测试（`verify-all.mjs:286-296`，
种子账号直连真实 `imap.163.com:993`）与 import18b 回退分支（`:1883-1895`，
真实 163 坏凭证行）都会联网访问真实 163 服务器；用的都是假授权码，
不会登录成功，但确实会产生真实 163 访问。其余部分用假账号/本地假 IMAP/SMTP。

- **启动/构建**：`tsc` 严格模式编译通过；`node dist/server.js` 正常监听。
- **认证**：setup（短密码 400、重复 409）、login（错密 401、未知用户 5 次后 429 +
  `retryAfter`）、未登录调 `/api/*` 401、登录后会话 Cookie 生效（`COOKIE_SECURE=1` 时名为 `__Host-lm_session`，否则为 `lm_session`）。
- **预设/账号**：`163.com` 预设正确、`exmail` 在表、未知域名回落 `imap./smtp.`；
  加假账号返回 400 且写明是 IMAP 哪一步失败、无 500、无堆栈外泄、账号未入库。
- **加密**：AES-256-GCM 加密后入库、解密还原一致；`.key` 32 字节、权限 0600。
- **WAL**：`PRAGMA journal_mode` 返回 `wal`；`-shm`/`-wal` 文件生成。
- **搜索**：两封中文邮件入库后，3 字以上词走 FTS5 trigram 命中；
  2 字词（`项目`）走 LIKE 兜底命中（trigram 本身查不到 <3 字的词，见下）。
- **列表/详情**：`all-inbox` 列出 2 封；详情从磁盘读回正文；
  附件元信息含 `size` 与 `large`（`large` 恒为 false，历史字段）。
- **附件**：下载时从 IMAP 实时流式返回 200；无 IMAP part 的返回 404 JSON，不崩溃。
- **连通测试接口**：假账号 `imapOk:false` + 明确错误
  `IMAP 连接失败（imap.163.com:993）：用户名或密码/授权码不正确（认证被拒：LOGIN Login error or password error）`。
- **DOMPurify**：手写 .eml（base64 正文、中文编码字主题、`<script>`、1x1 追踪像素）
  流式解析后主题/正文正确，`<script>` 与 1x1 像素被去掉、正常图片保留；
  `onerror` 与 `javascript:` 链接也被剥掉。
- **Worker**：>5MB 正文（约 10.5MB）在 worker 里解析成功、主线程未阻塞；
  12MB 附件只存元信息、磁盘零文件。
- **Socket.io**：带有效会话 Cookie（`COOKIE_SECURE=1` 时为 `__Host-lm_session`）的客户端连上并收到 `refresh-all`
  触发的 `sync {state:"done"}` 事件；无 Cookie 的连接被拒绝。
- **状态/设置**：签名保存后读回一致；未知接口 404 JSON。

### 163 可达性实证（假账号，只证明“摸得到、认得出”）

- **IMAP `imap.163.com:993`**：TLS 握手成功，登录后 imapflow 自动发了 ID 命令
  （日志里可看到 ID 命令；字段名加引号，`"name" "luck-mail"` 形式），
  随后服务器回 `3 NO LOGIN Login error or password error`，
  imapflow `authenticationFailed=true`。结论：**网络与 TLS 通、ID 机制生效、
  失败在认证（假授权码）**，不是连不上。
- **SMTP `smtp.163.com:465`**：`openssl s_client` 握手成功（证书 `*.163.com`，
  NetEase）；nodemailer `verify()` 约 1.7 秒回 `Invalid login: 550 User has no permission`
 （`EAUTH`，`AUTH PLAIN`）。结论：**SMTP 通、失败在认证**。
- 另：SMTP transporter 设了 15 秒连接/问候超时、30 秒读写超时，加账号时
  失败不会挂两分钟才返回。

### 流式 / Worker / WAL

- **纯流式（严禁读整封进内存）**：取全文走 `client.download(uid, '', {uid:true})`
  拿 `Readable` → `stream.pipeline` → mailparser `MailParser` 流式解析；
  附件只存元信息（文件名、大小、part 编号），不落盘。列表同步只拉信封
  （envelope + flags + bodyStructure + size，外加 TEXT 前 4KB 做摘要）。
  `simpleParser`（整封进内存）已删除，生产路径只用流式解析。
- **Worker Threads**：正文大小（`download.meta.expectedSize`）超过 5MB 时，
  主线程把下载流 spool 到临时文件（流式、有界内存），只把文件路径发给
  `worker_threads`，由 worker 流式读文件、解析、回传元数据+正文；
  临时文件随后删除。主线程全程只维护 IMAP 长连接与 API。
- **WAL**：`openDb()` 里连接后第一件事就是 `PRAGMA journal_mode=WAL`
 （另加 `synchronous=NORMAL`、`busy_timeout=5000`）；验证脚本用第二个连接
  并发读写同一库文件通过（种子数据就是这么写进去的）。

### 附件（元数据-only，不落盘）

- 附件**只存元信息**：文件名、大小（解码后准确字节数）、IMAP part 编号（取全文前先拿 `BODYSTRUCTURE`，把附件的 part 编号（`"2"`、`"1.2"`）存进 `attachments.part`）。不写磁盘、不缓存附件内容。
- 下载时 `GET /api/messages/:id/attachments/:attId` 用 `client.download(uid, part)` 实时从 IMAP 拉、直接 `pipeline` 到浏览器响应，全程不落盘。
- 附件元信息统一带 `size`（字节）与 `large`（恒为 false，历史字段，仅兼容）；前端不再据此标“较大”。

### 规模与技术栈

- **规模**：最多 50 个邮箱。单 Node 进程 + SQLite（WAL + FTS5）就是定稿的最优解：
  无 Redis / PostgreSQL / S3 / Elasticsearch / 微服务 / 集群；同步方式：
  网易系邮箱（163/126/yeah/188）走 5 分钟轮询（服务器约 206 秒静默断 IDLE，
  长连接无效），其余账号 IDLE 为主、另有 5 分钟兜底全文件夹轮询。
- **TypeScript 严格类型**：已落地。`tsconfig.json` 开 `strict: true`，
  `npm run build`（`tsc`）零错误；类型覆盖全部模块与路由（含 imapflow /
  better-sqlite3 / nodemailer / mailparser 的类型，MailComposer 类型来自 @types/nodemailer）。
- **DOMPurify 清洗已生效**：`src/sanitize.ts`，JSDOM + DOMPurify，
  禁 `style/form/input/iframe/object/embed` 等标签，去脚本、事件属性、
  `javascript:` 链接，另用 hook 删 1x1 追踪像素；验证脚本实测通过。
- **正文落盘而非存库**：洗净后的 HTML 存 `DATA_DIR/bodies/<messageId>.html`，
  纯文本存 `DATA_DIR/bodies/<messageId>.txt`；SQLite `messages` 表只存
  `body_path` + 标题/发件人/摘要等元数据；FTS5 是独立表（`subject/from_addr/body_text`，
  应用层维护），不依赖已删的 `body_text` 列。读信时从库取元数据、从磁盘取正文；
  API 返回的 `bodyText/bodyHtml` 形状不变。启动时还会把有正文文件但缺 FTS 行
  的邮件重新索引（backfill）。
- **FTS5 trigram 的已知限制**：trigram 查不到 <3 字的词（实测 2 字词 0 命中）。
  `searchMessageIds()` 对 <3 字的词自动走 `LIKE '%词%'` 兜底（查 FTS 表内存的
  三列），长词走 `MATCH`，两路取交集（长词组与短词组必须同时满足；以前是并集）。
  中文 2 字搜索已验证能命中。

### 已读状态口径（sent/drafts 一律已读）

- **已发送/草稿文件夹的邮件一律 `is_read=1`**：部分服务商（OquMail）不给
  已发送里的邮件打 `\Seen`，服务器 flags 永远是未读；已发送/草稿本来
  就是自己发出去/写好的信，没有“未读”的概念。同步入库/更新
  （`_upsertEnvelope`）、去重合并（F1 与发信缓存）、flags 全量对账
  （`_syncFlagsFull` 跳过 sent/drafts）三处都按此口径；`openDb()` 里
  有一次性幂等回填，把存量未读 sent/drafts 行翻成已读并重算文件夹计数。
- **trash/spam/inbox 不动**；账号角标仍是各文件夹 `unread_count` 的 SUM，
  口径没变。用户手动把已发送的信标未读也会在下次同步时被翻回已读
  （这是口径，不是 bug）。

### OquMail 发信限制（threading 头被剥离，审计 #12 H2）

- OquMail 服务器会在 SMTP 提交后整封重写：新 Message-ID + 剥离 In-Reply-To/References。父级实测：planned Message-ID 改用发件账号真实域名（`<uuid@heavycrusher.com>`）也照样重写；163 发到 QQ 时 planned Message-ID 原样保留——是 OquMail 服务端行为，不是 luck-mail 的问题（luck-mail 自己 APPEND 的已发送副本带正确的 threading 头，值与原信 Message-ID 一致）。
- 影响：OquMail 账号（heavycrusher.com / futdesk.ai 等 mail.oqumail.com 托管域名）发出的回复在收件方无法归入原会话，只能看到孤立新会话。
- 对策：不改发信路径（改 Message-ID 域名已证实无效）；已发送去重对此类账号用指纹兜底（主题/发件人/收件人/时间±10 秒/大小±1024 字节，`engine.ts` 的 `sentFingerprintMatches`；审计 #13 L2 起加收件人），至少保证“所有已发送”里一次发送只显示一行、删一封能清掉另一份副本。崩溃窗口重认领也按指纹查已发送（审计 #13 HIGH：本地库 + 服务器已发送文件夹两路；重认领时 size 未知，该分支放宽不校验大小）。审计 #12 之前已产生的旧重复行不自动合并清理，手动删其中一封可触发清扫清掉另一份；彻底删除时清扫删掉的双生副本 Message-ID 也写进墓碑，防复活（审计 #13 L1/L3）。

## 尚未用真实账号验证收信/发信全流程（2026-11-19 更新：已由线上实际使用覆盖）

原先诚实说明：以上验证主要用**假账号/假授权码**完成（例外见上：第 7 节与
import18b 回退分支会用假凭证联网访问真实 163 服务器）。以下须用户用真实 163
客户端授权码验证后才能算闭环（本机不向用户索要任何密码/授权码）：

1. 加真实 163 邮箱：IMAP 登录 + 文件夹 LIST + 收件箱增量同步 + 5 分钟轮询新邮件
   （163 不走 IDLE，新邮件最长约 5 分钟才出现）。
2. 打开一封真实邮件：全文拉取、DOMPurify 清洗、附件（实时从 IMAP 流式）下载。
3. 发一封真实邮件：Nodemailer 发送 + APPEND 副本到已发送 + 本地写库。
4. 移动/删除/标已读等 IMAP 写操作回写服务器。
5. 多账号（163 + QQ）同时在线、断线重连、Socket.io 实时角标。

**2026-11-19 更新**：线上（mm.ynzb.cn，134.175.136.13）已有 **31 个真实账号**
在跑（163 ×24、QQ ×3、OquMail ×4），真实收发信已发生，上述 5 项均已由线上
实际使用覆盖，不再是“尚未验证”：
1. 31 个真实账号均已完成 IMAP 登录、文件夹 LIST 与增量同步，163 走 5 分钟轮询。
2. 浏览器验证中多次打开真实邮件：全文拉取、DOMPurify 清洗、附件实时下载均正常。
3. 线上已发送已有 17 封真实发出记录（2026-11-19 快照；Nodemailer 发送 + 已发送 APPEND + 本地写库）。
4. 移动/删除/标已读的 IMAP 回写已在浏览器验证与日常使用中发生（删除防复活、
   标已读同步均经多轮验证）。
5. 31 账号同时在线、断线重连、Socket.io 实时角标已在生产跑通（新邮件推送、
   未读角标即时亮起均已验证）。

## 依赖安全跟踪（审计 #11）

- **multer**：CVE-2026-113872（GHSA-q7qp-rjg7-q26m，HIGH）影响 2.0.0–<2.5.0，
  触发条件是配置了异步 fileFilter 且请求中途被 abort；本项目两处 multer 配置
  均未配 fileFilter，漏洞路径不可达。已升级到 ≥2.5.0（见 `package.json`）。
- **exceljs 4.4.0**：多个 2026-11 公布的未修复 CVE（CVE-2026-128346/128338/
  78207/128339/128341/128342，均为读路径 `xlsx.load` / WorkbookReader / note
  序列化），截至审计 #11 时无修复版。本项目只用 exceljs **写**导出
  （`writeBuffer`），不读任何外部文件、不建 notes，漏洞路径走不到；待上游
  发布修复版后再升级。导入已改 CSV，不用 exceljs 读。

## 给父级集成部署的建议（只写建议，不执行）

- **systemd**（示例）：工作目录放后端根目录，`ExecStart=/usr/bin/node
  /opt/luck-mail/backend/dist/server.js`，环境 `PORT=8080
  DATA_DIR=/opt/luck-mail/data PUBLIC_DIR=/opt/luck-mail/backend/public
  KEY_FILE=/opt/luck-mail/.key COOKIE_SECURE=1`，另加
  `EnvironmentFile=/opt/luck-mail/.deepl-env`（0600，内含 `DEEPL_API_KEY` 一行；
  密钥绝不写进单元文件），
  `Restart=always`，`User=root`（与线上服务一致）；
  `DATA_DIR`（含 `.key`、SQLite、附件、正文）要持久化、定期备份，
  `.key` 丢了则所有已存邮箱密码无法解密（须重新添加邮箱）。
  先 `npm ci --omit=dev && npm run build`，再起服务；升级时先停服务、备份
  `DATA_DIR`、再替换 `dist/`。
- **OpenResty / nginx**：`mm.ynzb.cn` 反代到 `127.0.0.1:8080`；
  必须透传 `Upgrade`/`Connection` 头给 Socket.io（`/socket.io/` 长连接），
  并把 `proxy_read_timeout` 放到 120s 以上（IDLE/心跳不断线）；
  `client_max_body_size 25m`（附件上限）；HTTPS 证书沿用现有 Let's Encrypt 流程。
- **部署前备份**：按立规，先备份旧 SnappyMail/luck-mail 数据（若还有），
  验证新后端可用后再切换、再删旧的。
- **注意**：`backend/data/` 默认在仓库目录下，生产务必用 `DATA_DIR` 指到
  `/opt/luck-mail/data` 这类持久目录，不要把数据库放进代码目录。
