# luck-mail — lightweight webmail on top of SnappyMail.
# Single container, no database, no extra services.
# SnappyMail core is untouched; only our plugins + the IMAP ID patch are added.
FROM djmaze/snappymail:latest

# IMAP ID fix (RFC 2971): Coremail (163/126/yeah/188) refuses SELECT with
# "NO SELECT Unsafe Login" unless the client sends ID first (with quoted
# field names, otherwise "BAD Parse command error").
# Applied at build time so every rebuild keeps the fix.
COPY patches/imap-id-command.patch /tmp/imap-id-command.patch
RUN apk add --no-cache patch \
    && V=$(ls /snappymail/snappymail/v) \
    && sed -i "s|snappymail/v/3.0.1|snappymail/v/${V}|g" /tmp/imap-id-command.patch \
    && patch -p1 -d /snappymail < /tmp/imap-id-command.patch \
    && php -l "/snappymail/snappymail/v/${V}/app/libraries/MailSo/Imap/ImapClient.php" \
    && rm /tmp/imap-id-command.patch \
    && apk del patch

# Bundle the luck-mail plugins (seeded into the data dir by the entrypoint).
COPY plugins/luck-mail /snappymail/plugins-bundled/luck-mail
COPY plugins/luck-mail-theme /snappymail/plugins-bundled/luck-mail-theme
COPY entrypoint.sh /luck-mail-entrypoint.sh
COPY scripts/enable-plugins.php /usr/local/bin/luck-mail-enable-plugins.php
COPY scripts/configure-lightweight.php /usr/local/bin/luck-mail-configure-lightweight.php
RUN chmod +x /luck-mail-entrypoint.sh \
    && chown -R www-data:www-data /snappymail/plugins-bundled \
    && find /snappymail/plugins-bundled -type d -exec chmod 550 {} \; \
    && find /snappymail/plugins-bundled -type f -exec chmod 440 {} \;

ENTRYPOINT ["/luck-mail-entrypoint.sh"]
