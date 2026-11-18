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
    auth.ts               会话 Cookie（lm_session）、5 次锁定 15 分钟
    presets.ts            服务商预设表（另含 exmail）
    sanitize.ts           DOMPurify（JSDOM）：去脚本/事件属性/1x1 追踪像素
    mailUtil.ts           文件夹类型判定、BODYSTRUCTURE 附件 part
    mailStream.ts         流式解析：MailParser 流 + 附件元数据（不落盘）
    streamParse.ts        大正文路由：超阈值先落临时文件再扔 worker 解析
    parseWorker.ts        worker_threads 解析入口（只收文件路径，不收大 Buffer）
    imapUtil.ts           IMAP ID（RFC 2971）、连通测试、SMTP transporter 构造
    smtpUtil.ts           Nodemailer 发送 + MIME 原始报文（APPEND 到已发送）
    engine.ts             同步引擎：每账号一连接、IDLE、增量同步、读写删移、附件实时流
    hub.ts                Socket.io 广播（new-mail / mail-updated / mail-deleted / sync / account）
    routes/
      authRoutes.ts       status / setup / login / logout / change-password
      accountRoutes.ts    presets / accounts CRUD / test / refresh / folders
      messageRoutes.ts    列表 / 详情 / 标已读 / 移动 / 删除 / 发信 / 附件下载 / 搜索
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

## 验证结果（本地，`npm run verify`，46 项全过）

验证脚本 `scripts/verify-all.mjs`：在临时 `DATA_DIR` 上起编译后的服务器，
全程只用假账号/假授权码，不碰真实邮箱。2026-11-18 运行结果 **46 passed，0 failed**。

- **启动/构建**：`tsc` 严格模式编译通过；`node dist/server.js` 正常监听。
- **认证**：setup（短密码 400、重复 409）、login（错密 401、未知用户 5 次后 429 +
  `retryAfter`）、未登录调 `/api/*` 401、登录后 `lm_session` Cookie 生效。
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
- **Socket.io**：带有效 `lm_session` Cookie 的客户端连上并收到 `refresh-all`
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
  无 Redis / PostgreSQL / S3 / Elasticsearch / 微服务 / 集群；50 个邮箱全挂 IDLE，
  无离线降级轮询。
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
  三列），长词走 `MATCH`，两路并集。中文 2 字搜索已验证能命中。

## 尚未用真实账号验证收信/发信全流程

诚实说明：以上验证全部用**假账号/假授权码**完成。以下须用户用真实 163
客户端授权码验证后才能算闭环（本机不向用户索要任何密码/授权码）：

1. 加真实 163 邮箱：IMAP 登录 + 文件夹 LIST + 收件箱增量同步 + IDLE 新邮件推送。
2. 打开一封真实邮件：全文拉取、DOMPurify 清洗、附件（实时从 IMAP 流式）下载。
3. 发一封真实邮件：Nodemailer 发送 + APPEND 副本到已发送 + 本地写库。
4. 移动/删除/标已读等 IMAP 写操作回写服务器。
5. 多账号（163 + QQ）同时在线、断线重连、Socket.io 实时角标。

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
