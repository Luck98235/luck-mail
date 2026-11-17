<?php
/**
 * luck-mail lightweight profile — apply to SnappyMail's application.ini.
 *
 * Disables SnappyMail extras the user does not need, keeps the core
 * (receive / send / delete) and luck-mail's own features untouched:
 *
 *   DISABLED (extras):
 *     - PGP / GnuPG (security.openpgp, security.gnupg) — no encrypt/sign UI.
 *     - Contacts ([contacts] enable) — already Off in stock 3.0.1, pinned here.
 *     - Contact autosave on send ([defaults] contacts_autosave).
 *     - Extra From identities ([webmail] allow_additional_identities) —
 *       the default identity (the mailbox itself) still works for sending.
 *     - Identity popup after first login ([webmail] popup_identity) —
 *       identity is auto-created from the mailbox address.
 *     - Theme switching ([webmail] allow_themes) — locked to our theme.
 *     - Language switching ([webmail] allow_languages_on_settings,
 *       [login] allow_languages_on_login) — language fixed to zh.
 *     - SnappyMail's own remember-me ([login] sign_me_auto = Unused) —
 *       remember-me is provided by luck-mail's own login ("30天内免登录").
 *     - Drag & drop .eml append ([labs] allow_message_append) — already Off.
 *
 *   KEPT (core, do not touch):
 *     - [imap] fetch_new_messages, [capa] dangerous_actions (delete),
 *       [capa] attachments_actions, [defaults] allow_draft_autosave,
 *       [cache] enable, [security] allow_admin_panel.
 *
 *   Unified inbox is a REQUIRED luck-mail feature — it is NOT part of
 *   this trimming and is never disabled here.
 *
 * Idempotent: safe to run on every container start. Section-scoped edit,
 * preserves comments and unrelated keys. Atomic (temp file + rename).
 *
 * Usage: php configure-lightweight.php [path/to/application.ini]
 */
declare(strict_types=1);

$sIniPath = $argv[1] ?? '/var/lib/snappymail/_data_/_default_/configs/application.ini';

$aProfile = [
	'webmail' => [
		'allow_themes' => 'Off',
		'allow_languages_on_settings' => 'Off',
		'allow_additional_identities' => 'Off',
		'popup_identity' => 'Off',
		'language' => '"zh"',
	],
	'contacts' => [
		'enable' => 'Off',
		'allow_sync' => 'Off',
	],
	'security' => [
		'openpgp' => 'Off',
		'gnupg' => 'Off',
	],
	'login' => [
		'allow_languages_on_login' => 'Off',
		'determine_user_language' => 'Off',
		'sign_me_auto' => '"Unused"',
	],
	'defaults' => [
		'contacts_autosave' => 'Off',
	],
	'labs' => [
		'allow_message_append' => 'Off',
	],
];

if (!\is_file($sIniPath)) {
	\fwrite(\STDERR, "configure-lightweight: ini not found: {$sIniPath}\n");
	exit(1);
}
$sContent = \file_get_contents($sIniPath);
if (false === $sContent) {
	\fwrite(\STDERR, "configure-lightweight: cannot read {$sIniPath}\n");
	exit(1);
}

$aLines = \explode("\n", $sContent);
$aChanged = [];

foreach ($aProfile as $sSection => $aKeys) {
	// Locate the section header.
	$iSectionAt = null;
	$iSectionEnd = \count($aLines);
	foreach ($aLines as $i => $sLine) {
		if (\preg_match('/^\s*\[\s*' . \preg_quote($sSection, '/') . '\s*\]\s*$/', $sLine)) {
			$iSectionAt = $i;
		} elseif (null !== $iSectionAt && \preg_match('/^\s*\[.+\]\s*$/', $sLine)) {
			$iSectionEnd = $i;
			break;
		}
	}
	if (null === $iSectionAt) {
		// Section missing — append it at the end.
		$aLines[] = '';
		$aLines[] = "[{$sSection}]";
		foreach ($aKeys as $sKey => $sValue) {
			$aLines[] = "{$sKey} = {$sValue}";
			$aChanged[] = "{$sSection}.{$sKey} = {$sValue} (section added)";
		}
		continue;
	}
	foreach ($aKeys as $sKey => $sValue) {
		$bFound = false;
		for ($i = $iSectionAt + 1; $i < $iSectionEnd; $i++) {
			if (\preg_match('/^\s*' . \preg_quote($sKey, '/') . '\s*=/', $aLines[$i])) {
				if (\trim($aLines[$i]) !== "{$sKey} = {$sValue}") {
					$aLines[$i] = "{$sKey} = {$sValue}";
					$aChanged[] = "{$sSection}.{$sKey} = {$sValue}";
				}
				$bFound = true;
				break;
			}
		}
		if (!$bFound) {
			\array_splice($aLines, $iSectionEnd, 0, ["{$sKey} = {$sValue}"]);
			$iSectionEnd++;
			$aChanged[] = "{$sSection}.{$sKey} = {$sValue} (added)";
		}
	}
}

if (!$aChanged) {
	echo "configure-lightweight: already applied, nothing to change\n";
	exit(0);
}

$sTmp = $sIniPath . '.tmp.' . \getmypid();
if (false === \file_put_contents($sTmp, \implode("\n", $aLines))) {
	\fwrite(\STDERR, "configure-lightweight: cannot write temp file\n");
	exit(1);
}
if (!\rename($sTmp, $sIniPath)) {
	@\unlink($sTmp);
	\fwrite(\STDERR, "configure-lightweight: cannot replace {$sIniPath}\n");
	exit(1);
}
echo "configure-lightweight: applied " . \count($aChanged) . " setting(s):\n";
foreach ($aChanged as $sChange) echo "  - {$sChange}\n";
