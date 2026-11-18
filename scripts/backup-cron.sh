#!/bin/bash
# luck-mail 自动备份（审计 #5：部署轨第 1 项 / 安全轨 S8）
#
# 每天 03:00 由 cron 运行：
#   1. 用 better-sqlite3 的 db.backup() 给在线库做一致性快照
#      （在线库直接 tar 会拷到一半的 WAL，备份不可用）；
#   2. 打包快照库 + 主密钥 .key + bodies/ + attachments/；
#   3. 保留最近 3 份，超出的删最旧。
#
# 安装（在服务器 134.175.136.13 上以 root 执行）：
#   cp luck-mail-backup-cron.sh /opt/luck-mail/backup-cron.sh
#   chmod 700 /opt/luck-mail/backup-cron.sh
#   crontab -e
#     0 3 * * * /opt/luck-mail/backup-cron.sh >> /opt/luck-mail/backups/backup-cron.log 2>&1
#
# 恢复（灾后，简述——完整步骤见仓库 MIGRATION.md）：
#   systemctl stop luck-mail
#   tar -xzf luck-mail-backup-YYYYMMDD-HHMMSS.tar.gz -C /opt/luck-mail/restore
#   cp restore/luck-mail.db /opt/luck-mail/data/luck-mail.db
#   cp restore/.key /opt/luck-mail/.key && chmod 600 /opt/luck-mail/.key
#   cp -a restore/bodies restore/attachments /opt/luck-mail/data/
#   systemctl start luck-mail
# 注意：本脚本只做本机备份；异地副本需人工或另行同步（备份里有 .key，
# 传到异地时务必走加密通道，勿明文传网盘/邮件）。
set -euo pipefail

APP_DIR=/opt/luck-mail
BACKEND_DIR=/opt/luck-mail/backend
DATA_DIR=/opt/luck-mail/data
KEY_FILE=/opt/luck-mail/.key
BACKUP_DIR=/opt/luck-mail/backups/auto
RETENTION=3

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

mkdir -p "$BACKUP_DIR"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$BACKUP_DIR/luck-mail-backup-$STAMP.tar.gz"
STAGE=$(mktemp -d)
SNAP_DB="$STAGE/luck-mail.db"
trap 'rm -rf "$STAGE"' EXIT

# 1. 一致性快照（只读打开，不阻塞在线服务；WAL 模式下 backup 是安全的）。
log "snapshot db -> $SNAP_DB"
node -e "
const Database = require('$BACKEND_DIR/node_modules/better-sqlite3');
const db = new Database('$DATA_DIR/luck-mail.db', { readonly: true });
db.backup('$SNAP_DB').then(() => { db.close(); }).catch((e) => { console.error(e); process.exit(1); });
"

# 2. 打包：快照库 + .key + 正文/附件文件。
cp "$KEY_FILE" "$STAGE/.key"
for d in bodies attachments; do
  [ -d "$DATA_DIR/$d" ] && cp -a "$DATA_DIR/$d" "$STAGE/$d"
done
tar -czf "$OUT" -C "$STAGE" .
chmod 600 "$OUT"

# 3. 自检：包里必须有库与密钥，否则本次备份作废并报错。
if ! tar -tzf "$OUT" | grep -qx './luck-mail.db' || ! tar -tzf "$OUT" | grep -qx './.key'; then
  log "ERROR: backup $OUT missing luck-mail.db or .key, removing"
  rm -f "$OUT"
  exit 1
fi

# 4. 保留最近 $RETENTION 份，删最旧。
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/luck-mail-backup-*.tar.gz | tail -n +$((RETENTION + 1)) | xargs -r rm -f

log "backup ok: $OUT ($(du -h "$OUT" | cut -f1), $(ls "$BACKUP_DIR"/luck-mail-backup-*.tar.gz | wc -l) copies kept)"
