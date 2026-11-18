# luck-mail 前端（Vue 3 + Vite + TypeScript）

三栏蓝色布局（左侧导航、邮件列表、阅读窗），按 `../API_CONTRACT.md` 接 Node 后端 API。

## 技术栈

- Vue 3（`<script setup lang="ts">` SFC）+ Vite + TypeScript（`tsconfig.json` 开 `strict`）
- Pinia（全局 `useMailStore`）+ vue-router（`/` 主界面、`/login` 登录/创建账号）
- Tailwind CSS：本地构建（`@tailwindcss/vite`，不走 CDN，部署可靠）；FontAwesome 继续用 CDN
- socket.io-client：实时推送（单连接，同源 `/socket.io/`，不用原生 WebSocket）
- 主题切换：`body[data-theme]` + CSS 变量（`src/style.css`），6 色（蓝/绿/黑白/紫/橙/青），localStorage 键 `luck-mail-theme`

## 目录

```
frontend/
├── package.json / vite.config.ts / tsconfig.json / index.html
├── src/
│   ├── main.ts / App.vue / style.css
│   ├── api.ts            # 契约 API 封装（默认同源，credentials: include）
│   ├── realtime.ts       # Socket.io 单连接（事件归一化成 {type,...}）
│   ├── types.ts          # 与契约对齐的共享类型
│   ├── utils.ts          # 时间/头像/附件大小
│   ├── router/index.ts   # 路由守卫：未登录跳 /login
│   ├── stores/
│   │   ├── theme.ts      # 主题 + 配色面板定位
│   │   ├── auth.ts       # 登录/创建账号/锁定 429 友好提示
│   │   └── mail.ts       # 全局 useMailStore（见下）
│   ├── views/            # LoginView（image-111 白卡片）/ MailView（桌面 3 栏 + 移动端壳）
│   └── components/       # MailSidebar / MessageList（虚拟滚动）
│                         #   ReadingPane（沙盒 iframe）/ ComposeModal
│                         #   AddAccountModal（Foxmail 式）/ ManageAccountsModal
│                         #   SettingsModal / ThemePanel / MobileShell（QQ 式移动端）
├── scripts/
│   ├── mock-server.mjs       # 本地 mock 后端（仅供测试，不部署）
│   ├── smoke.mjs             # jsdom 冒烟测试（31 项）
│   └── api-contract-test.mjs # 契约形状检查（18 项）
└── dist/                 # 构建产物（构建后生成，部署时交给 Node serve）
```

## 构建与命令

```bash
cd ~/workspace/luck-mail/frontend
npm install
npm run build        # 产物输出到 dist/（index.html + assets/）
npm run typecheck    # vue-tsc --noEmit（TS 严格类型）
npm run dev          # 本地开发：http://localhost:5173
npm run smoke        # jsdom 冒烟（需先 build）
npm run test:api-contract
```

## 部署：dist 如何被 Node serve（给集成部署）

- Node 后端把 `frontend/dist/` 整个目录作为静态目录 serve（契约：`public/` 即 Vite dist），同源提供 `/api/*` 与 `/socket.io/`。
- 推荐做法（二选一，效果相同）：
  1. 构建机上 `npm run build`，把 `dist/` 复制/同步到后端 `public/`（`cp -r frontend/dist/* <后端>/public/`）；
  2. 或部署脚本里 `cd frontend && npm ci && npm run build && cp -r dist/* ../backend/public/`。
- 前端默认同源（`api.ts` 的 `BASE` 为空，`VITE_API_BASE_URL` 未设时即同源），**不需要改前端代码、不需要配跨域**。
- SPA fallback：后端对非 `/api/*`、非 `/socket.io/` 的 GET 返回 `dist/index.html`（`/login` 刷新后仍能进登录页）。
- 注意：`dist/` 不进 Git 也行（部署时现场构建）；若进仓库，构建产物每次构建都会变，以构建机产物为准。

## 本地开发联调

- `npm run dev`：Vite dev server（5173），`/api` 与 `/socket.io` 由 `vite.config.ts` 代理到 `VITE_API_TARGET`（默认 `http://localhost:8080`，即本地 Node 后端）。
  - 后端不在 8080 端口时：`VITE_API_TARGET=http://localhost:<端口> npm run dev`。
  - `VITE_API_TARGET` 与 `VITE_API_BASE_URL` 是两回事：前者只供 `npm run dev` 时 Vite 代理用（把 `/api`、`/socket.io` 代理到本地 Node 后端），不影响生产构建；后者是构建时打进 `api.ts` 的 API 前缀（默认空 = 同源），生产部署一般留空，只有跨域部署时才设。
- 联调检查清单（对真实后端时逐项过）：登录/创建账号 → 账号列表 → 点邮箱进单邮箱视图 → 聚合视图 → 收新邮件看角标 → 发信 → 删信 → 附件下载。

## 功能对照（按契约）

| 功能 | 实现 |
|---|---|
| 主界面 3 栏 | 左栏（Logo/写信/全部刷新/聚合分类/邮箱平铺，底部设置/配色/退出）+ 邮件列表 + 阅读窗 |
| 聚合/单邮箱视图 | 见下节“聚合/单邮箱视图” |
| 邮箱可展开文件夹 | 点邮箱行 = 展开 + 切单邮箱收件箱；点 `>` 只展开/折叠；点文件夹切该文件夹；只列服务器真实文件夹 |
| 邮件列表 | `GET /api/messages` 分页（limit/offset）+ `q` 搜索（FTS5，300ms 防抖）；虚拟滚动（只在 MailList）；点邮件打开正文即标已读 |
| 写信 | 发送（有附件走 multipart，无附件走 JSON）进已发送；回复/转发预填（带 threading 头）；存草稿走服务端 `/api/drafts`（自动保存） |
| 删除/标未读/标垃圾邮件 | 删除（已删除里再删 = 彻底删除）、`POST read`、`POST move` 到垃圾邮件文件夹 |
| 全部刷新 | `POST /api/refresh-all`，按钮转圈 + 重拉列表 |
| 登录/创建账号 | `GET /api/auth/status` 决定显示登录还是创建账号；401/429（锁定）友好提示；白卡片样式（用户名+密码小眼睛+30天免登录+蓝色按钮） |
| 加邮箱 | Foxmail 式弹窗；域名输入后 `GET /api/presets/:domain` 自动填服务器；创建调 `POST /api/accounts`，后端连通失败的错误原样显示 |
| 邮箱管理 | 弹窗表格：邮箱/备注名 inline 改/拖拽+上下移排序/操作（邮箱设置、临时停用、删除）；+ 添加邮箱；数量显示；确定/取消（暂存，确定才写回） |
| 设置 | 改密码（`POST /api/auth/change-password`）、默认账号、签名（`GET/PUT /api/settings`） |
| 配色切换 | 6 色，`body[data-theme]` + CSS 变量，滚动条跟随，localStorage 记住 |
| 响应式 | 桌面 ≥1024px 完整 3 栏；平板/手机 QQ 式布局（见下节） |
| 实时推送 | Socket.io 单连接，事件驱动 `unreadCounts`（见下节） |
| 附件显示 | 附件旁显示大小（B/KB/MB） |

## 规模与技术栈（用户 2026-11-17 00:42 定稿）

- 规模：最多 50 个邮箱，单 Node 进程 + SQLite 即最优解；**前端不用 Web Worker**（消息量小，主线程够）。
- TypeScript 严格类型已落地：全部源码为 `.ts` / `<script setup lang="ts">`，`tsconfig.json` 开 `strict`，`npm run typecheck`（vue-tsc --noEmit）仅 `AddAccountModal.vue:124` 一处既存类型报错（presetsCache 类型）；共享类型在 `src/types.ts`，与契约形状一一对应。
- 虚拟滚动只在 MailList：`src/components/MessageList.vue` 按固定行高（桌面 76px / QQ 式 84px）只渲染可视窗口 + 上下 5 行 overscan；账号树最多 50 个，直接 `v-for`，不用虚拟滚动。
- 懒加载已实现：`useMailStore.init()` 只调 `GET /api/accounts`（一级账号名）+ `GET /api/settings`，不预加载任何账号的文件夹；点邮箱行 / 折叠箭头时才调 `GET /api/accounts/:id/folders`（`loadFolders`，带缓存）。
- 读信渲染用沙盒 iframe（srcdoc）：`ReadingPane.vue` 不再用 `v-html` 直插主应用；正文放 `<iframe sandbox="allow-same-origin allow-popups" :srcdoc="...">`（不给 `allow-scripts`，脚本不执行；`allow-same-origin` 仅用于量高度自适应，`allow-popups` 让链接新窗口打开；链接统一 `target="_blank"`）。邮件内 CSS 覆盖不到主应用的浅蓝色 UI。

## Pinia useMailStore（用户 2026-11-17 00:37 定）

`src/stores/mail.ts`，全局唯一 store，所有列表/角标/未读数都走它：

- `accounts`：多邮箱基本信息与连接状态（`GET /api/accounts`）。
- `activeAccountId` / `activeFolder`：当前点的左栏邮箱与文件夹（与 `view` 同步；聚合视图时为 null）。
- `mailList`：缓存当前列表邮件（每页替换、搜索重拉都只改它，避免频繁请求 Node）。
- `unreadCounts`：响应式 `Map`（键 `total` / `account:<id>` / `folder:<accountId>:<folderId>`），左栏红色角标直接绑定它。
- 状态同步：删信、标已读/未读、收新邮件时，`unreadCounts` 与 `mailList`、左栏角标一起即时更新（`bumpUnread` 就地增减 + `mailList` 就地插/删/改），不整页刷新、不重新拉全量。`loadFolders` 只更新该账号的文件夹级计数（取 max 兜底），不冲掉事件刚加上的增量；账号级计数以 `loadAccounts` 的全量快照为准。

## 聚合/单邮箱视图（用户 2026-11-17 00:33 定）

- 点“所有收件箱/所有未读/所有草稿/所有已发送/所有已删除”：聚合视图，调 `GET /api/messages?view=all-inbox|all-unread|all-drafts|all-sent|all-trash`（不带 accountId），后端返回全部邮箱合并结果。
- 点邮箱列表里的某个邮箱：单邮箱视图，调 `GET /api/messages?view=folder&accountId=<id>&folderId=<该邮箱收件箱文件夹 id>`，只取该邮箱该文件夹。
- 点邮箱行 = 展开文件夹 + 切单邮箱收件箱视图；点行首 `>` 只展开/折叠，不切视图；点文件夹切到该邮箱该文件夹（`view=folder` + 对应 folderId）。
- “所有收件箱”下保留各邮箱子项，方便点某个邮箱单独查看。

## 移动/平板（用户 2026-11-17 00:31 定，参考 QQ 邮箱 APP 图 image-116/117/118）

- 布局学 QQ、配色用本项目浅色主题（不用 QQ 的深色）：`src/components/MobileShell.vue`，`body[data-theme]` 变量全程生效，与桌面端同一套 6 色。
- 手机 <768px 单栏三级：账号总览（账号头：头像+用户名+主账号+默认邮箱；搜索；常用文件夹：所有收件箱/所有未读/所有草稿/所有已发送/所有已删除；我的邮箱平铺；底部设置/改密码/配色/退出）→ 邮箱内（顶部返回 + 账号切换下拉 + 写信；页签：当前文件夹 / 未读邮件 / 管理；侧滑文件夹菜单：该邮箱真实文件夹 + 管理/刷新入口；QQ 式邮件列表：头像圆+发件人/主题/摘要两行+日期+>）→ 阅读窗（返回 + 同款操作栏 + 沙盒 iframe 正文）。
- 平板 768–1024px：左栏固定为账号总览（300px），右栏为列表/阅读窗。
- 桌面 ≥1024px 保持现有 3 栏不变。

## 实时推送（用户 2026-11-17 00:34 定）

- 前端不直连 IMAP，只与 Node 建一个 Socket.io 连接（`src/realtime.ts`，`socket.io-client`，同源 `/socket.io/`，不用原生 WebSocket、不用 `ws` 库）。
- 事件名与契约一致：`new-mail` / `mail-updated` / `mail-deleted` / `sync` / `account`；客户端只发 `ping` 保活（Socket.io 自带心跳）。
- `new-mail` 到达时：相关视图的 `mailList` 顶部插入新邮件，同时 `unreadCounts`（Map）按账号/文件夹 +1，左栏红色角标即时亮起；`mail-updated` 按 `isRead` 变化增减；删信时未读总数即时减少。整个过程不轮询、不整页刷新。

## 附件显示

- 读信时附件旁显示大小（`formatSize`：B/KB/MB）；附件只存元信息（文件名、大小、IMAP part 编号），不落盘、不缓存内容，下载时从邮箱服务器实时取。
- `src/types.ts` 的 `large` 字段恒为 `false`（历史字段，仅兼容），前端不再据此判断大小。

## 验证结果（本地，2026-11-18）

```bash
npm run build              # ✓ 成功，dist/index.html + assets（JS 251KB / CSS 35KB，gzip 84KB / 7.4KB）
npm run typecheck          # ✓ vue-tsc --noEmit（TS strict；仅 AddAccountModal.vue:124 一处既存类型报错）
npm run test:api-contract  # ✓ 18/18（对 mock 后端逐项核对契约返回形状）
npm run smoke              # ✓ 33/33（jsdom 挂载 dist + mock 后端 + Socket.io）
```

冒烟 33 项逐条（与 `scripts/smoke.mjs` 的断言名一致）：登录页渲染：用户名/密码框、登录按钮、30天内免登录 ✓；主题：localStorage luck-mail-theme=green 生效 ✓；登录失败（401）友好提示 ✓；主界面 3 栏结构：左栏/列表/阅读窗 ✓；聚合分类 5 项齐全 ✓；邮箱平铺无分组：两个账号在列，无“分组”入口 ✓；阅读窗不自动打开第一封（列表加载后为空状态，手动点开才进阅读窗）✓；读信渲染：沙盒 iframe（srcdoc），正文在 iframe 内、不直接 v-html 插主应用 ✓；请求：GET /api/auth/status ✓；请求：POST /api/auth/login（JSON 用户名+密码）✓；请求：GET /api/accounts ✓；请求：聚合视图 GET /api/messages?view=all-inbox（不带 accountId）✓；懒加载：初始化不预取文件夹（无 /folders 请求），点邮箱后才按需加载 ✓；Socket.io 客户端连上 mock 服务端 ✓；收到 new-mail 后左栏角标即时 (1)->(2)（Pinia unreadCounts 响应式更新）✓；收到 new-mail 后新邮件进 mailList（无需刷新）✓；点邮箱行：调 view=folder&accountId=2&folderId=21（只看该邮箱收件箱）✓；懒加载：点邮箱行时才调 GET /api/accounts/2/folders ✓；点所有未读：调 view=all-unread（不带 accountId，全部邮箱合并）✓；单封删除先弹确认框 ✓；删除调 DELETE /api/messages/:id ✓；删信后列表为空态（本地 mailList 即时更新，未重新拉全量）✓；删除失败时 toast 为“删除失败，请重试”（后端原话透传）✓；删除失败时行仍在列表（服务端未删成，对账后不闪空）✓；写信发送调 POST /api/messages/send ✓；发信带 idempotencyKey（UUID，同一封重试复用）✓；发信成功提示“发送成功”✓；发信后切到所有已发送、首封（刚发的信）自动打开 ✓；移动端 QQ 布局：账号总览（常用文件夹/我的邮箱）在 DOM ✓；移动端 QQ 布局：侧滑文件夹抽屉在 DOM ✓；移动端 QQ 布局：页签（未读邮件/管理）在 DOM ✓。

## 历史记录：2026-11-17 的 mock 验证（当时尚未接真实后端联调）

- 2026-11-17 时以上验证全部对本地 mock（`scripts/mock-server.mjs`，按契约形状返回 + Socket.io 推 `new-mail`），**当时没有接真实 Node 后端、没有真实 IMAP 账号**。之后已接真实后端并部署到 `mm.ynzb.cn` 上线；本节只保留当时的验证背景，不再代表现状。联调时以后端真实返回为准，重点核对：登录 Cookie（`lm_session`）、`view=folder` 的 folderId、Socket.io 握手（Cookie 校验）、附件下载流。
- 已知缺口（非 bug，是契约/实现现状）：
  - 存草稿已改存服务器：`存草稿` 走 `/api/drafts`（POST 建、PUT 更新，输入停约 1 秒自动保存；发信成功后服务端按 draftId 自动删草稿）；浏览器 localStorage 键 `luck-mail-local-drafts` 只剩一次性迁移（旧本机草稿在 init 时逐条 POST 到服务端，成功后清空旧键）。
  - 虚拟滚动只在 mock 的 3 封邮件上跑过渲染正确性，未用大数据量（50~200 封）实测滚动/窗口切换性能。
  - iframe 自适应高度（`resizeFrame` 量 `scrollHeight`）在 jsdom 里无法验证，需在真浏览器里看长邮件。
  - “30天内免登录”复选框：勾选值随登录请求发给后端（`rememberMe`），后端据此建 30 天或 1 天会话；localStorage 只记复选框偏好供下次回填（`luck-mail-remember`）。
  - FontAwesome 仍走 CDN；离线环境图标会缺失（布局不受影响）。如需完全离线，把 FontAwesome 换成本地字体文件即可。
  - 未做真机手机/平板验证，只有 jsdom DOM 冒烟 + CSS 断点（<768 / 768–<1024 / ≥1024）；联调后请在真机上过一遍 QQ 式三级流程。

## 红线遵守情况

- 没向用户索要任何密码/授权码；代码与文档里无真实凭据（测试用的 `correct-password` / `wrong-password` 只在 mock 里）。
- 没 push GitHub、没碰服务器、没动 `backend/`、`/opt/luck-mail`、中邦站/外贸站。
