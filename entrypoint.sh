#!/bin/sh
# luck-mail entrypoint.
# Seeds the bundled luck-mail plugins into the SnappyMail data dir, enables
# them in application.ini, then hands over to the stock SnappyMail entrypoint.
# Idempotent: safe to run on every container start (image updates are picked up).
set -eu

DATA_DIR=/var/lib/snappymail
PLUGIN_DIR="$DATA_DIR/_data_/_default_/plugins"
CONFIG_FILE="$DATA_DIR/_data_/_default_/configs/application.ini"

# 1. Make sure the SnappyMail data dir + default config exist.
#    (Same first-boot step the stock entrypoint performs.)
if [ ! -f "$CONFIG_FILE" ]; then
    echo "[luck-mail] Creating default SnappyMail configuration"
    su - www-data -s /bin/sh -c 'php /snappymail/index.php' > /tmp/luck-mail-init-out || { cat /tmp/luck-mail-init-out; exit 1; }
fi

# 2. Seed the bundled luck-mail plugins into the data dir.
#    Overwrite on every start so a rebuilt image is picked up.
#    NOTE: account data lives in $DATA_DIR/_data_/_default_/luck-mail/ (NOT inside
#    the plugin folders), so re-seeding never wipes accounts.
echo "[luck-mail] Seeding plugins"
mkdir -p "$PLUGIN_DIR"
rm -rf "$PLUGIN_DIR/luck-mail" "$PLUGIN_DIR/luck-mail-theme"
cp -r /snappymail/plugins-bundled/luck-mail "$PLUGIN_DIR/luck-mail"
cp -r /snappymail/plugins-bundled/luck-mail-theme "$PLUGIN_DIR/luck-mail-theme"
chown -R www-data:www-data "$PLUGIN_DIR/luck-mail" "$PLUGIN_DIR/luck-mail-theme"

# 2b. Clear SnappyMail's compiled caches (plugin JS/CSS bundle + templates).
#     The bundle cache key is derived from the plugin VERSION + file list,
#     NOT file contents — without this, a rebuilt image with changed JS/CSS
#     would keep serving the old bundle (verified 2026-11-16: the bundle
#     stayed byte-identical after a JS change until the cache was cleared).
#     The cache regenerates on first request; CACHEDIR.TAG is kept.
CACHE_DIR="$DATA_DIR/_data_/_default_/cache"
if [ -d "$CACHE_DIR" ]; then
    echo "[luck-mail] Clearing compiled caches"
    find "$CACHE_DIR" -type f ! -name CACHEDIR.TAG -delete
fi

# 3. Enable the plugins in application.ini (idempotent).
php /usr/local/bin/luck-mail-enable-plugins.php "$CONFIG_FILE"

# 4. Apply the lightweight profile (idempotent): disable SnappyMail extras
#    the user does not need (PGP, contacts, extra identities, theme/language
#    switching); core receive/send/delete and the unified inbox are untouched.
php /usr/local/bin/luck-mail-configure-lightweight.php "$CONFIG_FILE"

# 5. Config files must stay writable by php-fpm (www-data): our PHP scripts
#    rewrite application.ini via temp+rename, which would leave it root-owned.
chown www-data:www-data "$CONFIG_FILE"

# 6. Hand over to the stock SnappyMail entrypoint.
exec /entrypoint.sh
