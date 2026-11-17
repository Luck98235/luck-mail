<?php
/**
 * luck-mail: enable the luck-mail plugins in application.ini (idempotent).
 *
 * Usage: php luck-mail-enable-plugins.php /path/to/application.ini
 *
 * Sets, inside the [plugins] section:
 *   enable = On
 *   enabled_list = "luck-mail,luck-mail-theme"
 * Preserves all other lines and comments. Creates the keys if missing.
 * Writes atomically (temp file + rename).
 */

if ($argc < 2) {
    fwrite(STDERR, "usage: php luck-mail-enable-plugins.php <application.ini>\n");
    exit(2);
}

$sFile = $argv[1];
if (!is_file($sFile)) {
    fwrite(STDERR, "config not found: {$sFile}\n");
    exit(2);
}

$aWanted = ['luck-mail', 'luck-mail-theme'];
$aLines = file($sFile, FILE_IGNORE_NEW_LINES);
if (false === $aLines) {
    fwrite(STDERR, "cannot read: {$sFile}\n");
    exit(1);
}

$sSection = '';
$bInPlugins = false;
$bHasEnable = false;
$bHasList = false;
$bChanged = false;

foreach ($aLines as $i => $sLine) {
    if (preg_match('/^\s*\[([^\]]+)\]\s*$/', $sLine, $m)) {
        $sSection = trim($m[1]);
        $bInPlugins = ('plugins' === $sSection);
        continue;
    }
    if (!$bInPlugins) continue;
    if (preg_match('/^\s*enable\s*=\s*(.*)$/', $sLine, $m)) {
        $bHasEnable = true;
        if ('On' !== trim($m[1], " \t\"'")) {
            $aLines[$i] = 'enable = On';
            $bChanged = true;
        }
        continue;
    }
    if (preg_match('/^\s*enabled_list\s*=\s*(.*)$/', $sLine, $m)) {
        $bHasList = true;
        $sCurrent = trim($m[1], " \t\"'");
        $aCurrent = array_filter(array_map('trim', explode(',', $sCurrent)));
        $aMerged = array_values(array_unique(array_merge($aCurrent, $aWanted)));
        $sNew = '"' . implode(',', $aMerged) . '"';
        if ($sNew !== trim($m[1])) {
            $aLines[$i] = 'enabled_list = ' . $sNew;
            $bChanged = true;
        }
    }
}

// Append missing keys at the end of the [plugins] section.
if (!$bHasEnable || !$bHasList) {
    $aOut = [];
    $bInserted = false;
    $sSection = '';
    foreach ($aLines as $sLine) {
        if (preg_match('/^\s*\[([^\]]+)\]\s*$/', $sLine, $m)) {
            if ('plugins' === $sSection && !$bInserted) {
                if (!$bHasEnable) $aOut[] = 'enable = On';
                if (!$bHasList)   $aOut[] = 'enabled_list = "' . implode(',', $aWanted) . '"';
                $bInserted = true;
                $bChanged = true;
            }
            $sSection = trim($m[1]);
        }
        $aOut[] = $sLine;
    }
    if ('plugins' === $sSection && !$bInserted) {
        if (!$bHasEnable) $aOut[] = 'enable = On';
        if (!$bHasList)   $aOut[] = 'enabled_list = "' . implode(',', $aWanted) . '"';
        $bChanged = true;
    }
    $aLines = $aOut;
}

if (!$bChanged) {
    echo "plugins already enabled\n";
    exit(0);
}

$sTmp = $sFile . '.tmp.' . getmypid();
if (false === file_put_contents($sTmp, implode("\n", $aLines) . "\n", LOCK_EX)) {
    fwrite(STDERR, "cannot write: {$sTmp}\n");
    exit(1);
}
if (!rename($sTmp, $sFile)) {
    @unlink($sTmp);
    fwrite(STDERR, "cannot replace: {$sFile}\n");
    exit(1);
}
echo "plugins enabled: " . implode(',', $aWanted) . "\n";
