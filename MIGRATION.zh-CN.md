# luck-mail — 迁移说明

[English version](MIGRATION.md)

把一台正在运行的 luck-mail 迁到新服务器的方法，以及为了无缝迁移需要备份
什么。部署方法见 [README.zh-CN.md](README.zh-CN.md)，数据模型见
[API_CONTRACT.md](API_CONTRACT.md)。

## 数据存在哪里

luck-mail 的所有数据都在服务器上的**两个地方**：

| 路径 | 存什么 |
| --- | --- |
| `/opt/luck-mail/.key` | 32 字节 AES-256-GCM 加密密钥（文件权限 `0600`）。所有邮箱密码都用这个密钥加密后才存进数据库。 |
| `/opt/luck-mail/data/` | SQLite 数据库 `luck-mail.db`、邮件正文 `bodies/`、2026-11-17 之前缓存的旧附件 `attachments/`。 |

数据库里存的是：登录账号、全部邮箱账号（地址、**加密后的**密码、服务器
设置、别名、排序、停用状态）、从各邮件服务器同步来的文件夹、邮件元信息
（主题、发件人、收件人、日期、摘要、已读状态、UID、Message-ID）、附件元信
息（文件名、大小、类型、IMAP 位置号——内容**不存**）、各文件夹的同步断点、
已彻底删除邮件的墓碑（删掉的信不会再回来）、设置（签名、默认账号）、草稿
（含幂等键）、全文搜索索引（FTS5）和登录会话。

代码本身就是本仓库，**不需要另外备份**，新服务器上从 GitHub 重新部署即可。

邮件本体在邮件服务器上（163、Gmail、Outlook……），本地数据库只是同步来的
副本/缓存。所以数据库丢了也能通过重新加邮箱、重新同步重建——但数据库
**连同密钥一起恢复**，才是无缝迁移：不用重新加邮箱、不用全量重同步，
已读状态和文件夹和原来一模一样。

**密钥和数据库必须一起备份，缺一不可**，单有一样恢复不了邮箱密码：

- 密钥丢了、数据库还在 → 账号列表都在，但密码解不出来，每个邮箱都得删掉
  重加，重新输授权码。
- 数据库丢了、密钥还在 → 账号列表本身就在数据库里，所以每个邮箱都得重加。
  光有密钥恢复不了任何东西。重加后所有邮件从邮件服务器重新同步（第一次
  同步比较慢）。
- 两个都丢了 → 全新安装：重新创建登录账号、重新加全部邮箱，邮件从服务器
  重新同步。

## 哪些东西不会跟着迁移

- **配色偏好** — 也是浏览器 `localStorage`。
- **登录会话** — 迁移后需要重新登录。
- **TLS 证书** — 新服务器上重新签发（Let's Encrypt）。

## 备份（在旧服务器上）

首选：站内**备份到本地**按钮（设置里），经 `POST /api/backup/download`
下载 `.key` + `data/` 的包——用一致的数据库快照（`db.backup()`），**不用停
服务**。

手动办法（网页打不开时）：先停服务，让 SQLite 数据库处于一致状态，再把
**密钥和数据目录一起**打成一个包：

```bash
sudo systemctl stop luck-mail
sudo tar -czf luck-mail-backup-$(date +%Y%m%d).tar.gz -C /opt/luck-mail .key data
# 把包拷到新服务器，例如：
scp luck-mail-backup-*.tar.gz root@<新服务器>:/tmp/
```

整个数据目录很小（截至 2026-11-18 的参考值：27 个邮箱、228 封邮件，一共 7.8MB：
DB 1.7MB + WAL 4.1MB + bodies 1.6MB + attachments 556KB），
每天备一份也不贵。备份要放在**服务器之外**的地方。

## 迁移步骤（在新服务器上）

### 1. 装好前置条件

- **Node.js 22**（后端跑在 Node 22 上）。
- 反向代理（OpenResty / nginx）和一个指向新服务器的域名。
- SQLite3 命令行只是可选项，仅用于检查。

### 2. 拉代码

```bash
git clone https://github.com/Luck98235/luck-mail   # 私有仓库，需认证
cd luck-mail/backend && npm ci && npm run build
cd ../frontend && npm ci && npm run build
cp -r dist ../backend/public   # 后端从 public/ 提供构建好的前端
# 再把构建好的 backend 拷到 /opt/luck-mail/backend
```

这里用 `npm ci`（按 `package-lock.json` 干净、可复现地安装）；`npm install`
是本地开发加依赖、改依赖时用的。

或者直接从旧服务器把 `/opt/luck-mail/backend` 整个拷过来。

### 3. 恢复密钥和数据

```bash
sudo mkdir -p /opt/luck-mail
sudo tar -xzf /tmp/luck-mail-backup-YYYYMMDD.tar.gz -C /opt/luck-mail
sudo chmod 600 /opt/luck-mail/.key
sudo ls -l /opt/luck-mail/.key /opt/luck-mail/data/luck-mail.db
```

密钥权限**必须**是 `0600`。权限不对或文件缺失，服务就解不开存着的邮箱
密码。

### 4. 建服务并启动

`/etc/systemd/system/luck-mail.service`：

```ini
[Unit]
Description=luck-mail
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/luck-mail/backend
ExecStart=/usr/bin/node /opt/luck-mail/backend/dist/server.js
Environment=PORT=8080
Environment=DATA_DIR=/opt/luck-mail/data
Environment=PUBLIC_DIR=/opt/luck-mail/backend/public
Environment=KEY_FILE=/opt/luck-mail/.key
Environment=COOKIE_SECURE=1
Environment=DEEPL_API_KEY=<DeepL 密钥>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now luck-mail
sudo systemctl status luck-mail   # 应为 active
```

### 5. 反向代理和证书

把 `/`（以及 `/socket.io/`，带 `Upgrade` 头走 WebSocket）反代到
`127.0.0.1:8080`，`proxy_read_timeout 120s`，`client_max_body_size 25m`。
给域名签发 Let's Encrypt 证书，HTTP 跳转 HTTPS。

证书自动续期：`/opt/acme/renew.sh` 每天 03:30 由 cron 跑，续 Let's Encrypt
证书（ACME 挑战走 webroot），然后 reload `1Panel-openresty` 容器（反向代理），
让新证书生效。看 `/opt/acme/renew.log` 查上次运行和下次续期时间。

### 6. 验证

- `systemctl status luck-mail` 为 active，`journalctl -u luck-mail` 里没有
  报错。
- 打开网站重新登录（会话不会带过来，需要重新登录）。
- 全部邮箱显示在线，邮件、文件夹、已读状态和原来一模一样。
- 发一封测试邮件确认能收到；打开一个附件确认能下载（附件是按 IMAP 位置
  号从邮件服务器实时取的）。

## 备份建议

`.key` + `data/` **一起**定期备份（每天备一份就行，包只有几 MB），备份存
在服务器之外。只含其中一样的备份，恢复不了邮箱密码。
