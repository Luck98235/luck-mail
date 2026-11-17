// Provider presets — verbatim port of plugins/luck-mail/lib/Presets.php
// (same table; server re-validates on save). `exmail` is a named extra entry.
// imapSecure / smtpSecure: 'SSL' (993/465 direct TLS) or 'STARTTLS' (587).
// Each entry: [imapHost, imapPort, imapSecure, smtpHost, smtpPort, smtpSecure, note]
export interface Preset {
  imapHost: string;
  imapPort: number;
  imapSecure: string;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: string;
  note: string;
}

type RawPreset = [string, number, string, string, number, string, string];

const RAW: Record<string, RawPreset> = {
  // NetEase (Coremail) — login needs the client auth code, not the web password.
  '163.com': ['imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', '163 请用客户端授权码，不是网页密码'],
  '126.com': ['imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', '126 请用客户端授权码，不是网页密码'],
  'yeah.net': ['imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', 'yeah 请用客户端授权码，不是网页密码'],
  '188.com': ['imap.163.com', 993, 'SSL', 'smtp.163.com', 465, 'SSL', '188 请用客户端授权码，不是网页密码'],
  // Google — needs an App Password (2-Step Verification on).
  'gmail.com': ['imap.gmail.com', 993, 'SSL', 'smtp.gmail.com', 587, 'STARTTLS', 'Gmail 请用应用专用密码'],
  'googlemail.com': ['imap.gmail.com', 993, 'SSL', 'smtp.gmail.com', 587, 'STARTTLS', 'Gmail 请用应用专用密码'],
  // Microsoft.
  'outlook.com': ['outlook.office365.com', 993, 'SSL', 'smtp.office365.com', 587, 'STARTTLS', ''],
  'outlook.com.cn': ['outlook.office365.com', 993, 'SSL', 'smtp.office365.com', 587, 'STARTTLS', ''],
  'hotmail.com': ['outlook.office365.com', 993, 'SSL', 'smtp.office365.com', 587, 'STARTTLS', ''],
  'live.com': ['outlook.office365.com', 993, 'SSL', 'smtp.office365.com', 587, 'STARTTLS', ''],
  'msn.com': ['outlook.office365.com', 993, 'SSL', 'smtp.office365.com', 587, 'STARTTLS', ''],
  // Tencent QQ mail — needs an auth code.
  'qq.com': ['imap.qq.com', 993, 'SSL', 'smtp.qq.com', 465, 'SSL', 'QQ 请用授权码，不是 QQ 密码'],
  'foxmail.com': ['imap.qq.com', 993, 'SSL', 'smtp.qq.com', 465, 'SSL', 'QQ 请用授权码，不是 QQ 密码'],
  // Yahoo — needs an app password; enable IMAP in webmail settings first.
  'yahoo.com': ['imap.mail.yahoo.com', 993, 'SSL', 'smtp.mail.yahoo.com', 465, 'SSL', 'Yahoo 请用应用专用密码，并先在网页设置里开启 IMAP'],
  'yahoo.com.cn': ['imap.mail.yahoo.com', 993, 'SSL', 'smtp.mail.yahoo.com', 465, 'SSL', 'Yahoo 请用应用专用密码，并先在网页设置里开启 IMAP'],
  'ymail.com': ['imap.mail.yahoo.com', 993, 'SSL', 'smtp.mail.yahoo.com', 465, 'SSL', 'Yahoo 请用应用专用密码，并先在网页设置里开启 IMAP'],
  'rocketmail.com': ['imap.mail.yahoo.com', 993, 'SSL', 'smtp.mail.yahoo.com', 465, 'SSL', 'Yahoo 请用应用专用密码，并先在网页设置里开启 IMAP'],
  // Apple iCloud — needs an app-specific password.
  'icloud.com': ['imap.mail.me.com', 993, 'SSL', 'smtp.mail.me.com', 587, 'STARTTLS', 'iCloud 请用应用专用密码；IMAP 用户名有时只需 @ 前面的部分'],
  'me.com': ['imap.mail.me.com', 993, 'SSL', 'smtp.mail.me.com', 587, 'STARTTLS', 'iCloud 请用应用专用密码；IMAP 用户名有时只需 @ 前面的部分'],
  'mac.com': ['imap.mail.me.com', 993, 'SSL', 'smtp.mail.me.com', 587, 'STARTTLS', 'iCloud 请用应用专用密码；IMAP 用户名有时只需 @ 前面的部分'],
  // AOL — needs an app password.
  'aol.com': ['imap.aol.com', 993, 'SSL', 'smtp.aol.com', 465, 'SSL', 'AOL 请用应用专用密码'],
  'aim.com': ['imap.aol.com', 993, 'SSL', 'smtp.aol.com', 465, 'SSL', 'AOL 请用应用专用密码'],
  // Yandex — needs an app password; enable IMAP in webmail settings first.
  'yandex.com': ['imap.yandex.com', 993, 'SSL', 'smtp.yandex.com', 465, 'SSL', 'Yandex 请用应用专用密码，并先在网页设置里开启 IMAP'],
  'yandex.ru': ['imap.yandex.com', 993, 'SSL', 'smtp.yandex.com', 465, 'SSL', 'Yandex 请用应用专用密码，并先在网页设置里开启 IMAP'],
  'ya.ru': ['imap.yandex.com', 993, 'SSL', 'smtp.yandex.com', 465, 'SSL', 'Yandex 请用应用专用密码，并先在网页设置里开启 IMAP'],
  // Zoho — personal accounts; org accounts use imappro.zoho.com / smtppro.zoho.com.
  'zoho.com': ['imap.zoho.com', 993, 'SSL', 'smtp.zoho.com', 465, 'SSL', 'Zoho 企业账号请用 imappro.zoho.com / smtppro.zoho.com；先开启 IMAP 访问'],
  'zohomail.com': ['imap.zoho.com', 993, 'SSL', 'smtp.zoho.com', 465, 'SSL', 'Zoho 企业账号请用 imappro.zoho.com / smtppro.zoho.com；先开启 IMAP 访问'],
  // GMX — SMTP host is mail.gmx.*, NOT smtp.gmx.*; enable IMAP in settings first.
  'gmx.com': ['imap.gmx.com', 993, 'SSL', 'mail.gmx.com', 587, 'STARTTLS', 'GMX 请先在网页设置里开启 IMAP'],
  'gmx.us': ['imap.gmx.com', 993, 'SSL', 'mail.gmx.com', 587, 'STARTTLS', 'GMX 请先在网页设置里开启 IMAP'],
  'gmx.net': ['imap.gmx.net', 993, 'SSL', 'mail.gmx.net', 587, 'STARTTLS', 'GMX 请先在网页设置里开启 IMAP'],
  'gmx.de': ['imap.gmx.net', 993, 'SSL', 'mail.gmx.net', 587, 'STARTTLS', 'GMX 请先在网页设置里开启 IMAP'],
  'gmx.at': ['imap.gmx.net', 993, 'SSL', 'mail.gmx.net', 587, 'STARTTLS', 'GMX 请先在网页设置里开启 IMAP'],
  'gmx.fr': ['imap.gmx.net', 993, 'SSL', 'mail.gmx.net', 587, 'STARTTLS', 'GMX 请先在网页设置里开启 IMAP'],
  'gmx.ch': ['imap.gmx.net', 993, 'SSL', 'mail.gmx.net', 587, 'STARTTLS', 'GMX 请先在网页设置里开启 IMAP'],
  // Mail.com
  'mail.com': ['imap.mail.com', 993, 'SSL', 'smtp.mail.com', 465, 'SSL', ''],
  // Fastmail — needs an app password.
  'fastmail.com': ['imap.fastmail.com', 993, 'SSL', 'smtp.fastmail.com', 465, 'SSL', 'Fastmail 请用应用专用密码'],
  'fastmail.fm': ['imap.fastmail.com', 993, 'SSL', 'smtp.fastmail.com', 465, 'SSL', 'Fastmail 请用应用专用密码'],
  // Mail.ru — app password if 2FA is on.
  'mail.ru': ['imap.mail.ru', 993, 'SSL', 'smtp.mail.ru', 465, 'SSL', 'mail.ru 开启两步验证后请用应用专用密码'],
  'inbox.ru': ['imap.mail.ru', 993, 'SSL', 'smtp.mail.ru', 465, 'SSL', 'mail.ru 开启两步验证后请用应用专用密码'],
  'list.ru': ['imap.mail.ru', 993, 'SSL', 'smtp.mail.ru', 465, 'SSL', 'mail.ru 开启两步验证后请用应用专用密码'],
  'bk.ru': ['imap.mail.ru', 993, 'SSL', 'smtp.mail.ru', 465, 'SSL', 'mail.ru 开启两步验证后请用应用专用密码'],
  // Sina — needs a 16-char client auth code.
  'sina.com': ['imap.sina.com', 993, 'SSL', 'smtp.sina.com', 587, 'STARTTLS', '新浪请用 16 位客户端授权码'],
  'sina.cn': ['imap.sina.com', 993, 'SSL', 'smtp.sina.com', 587, 'STARTTLS', '新浪请用 16 位客户端授权码'],
  // Sohu — needs an independent password.
  'sohu.com': ['imap.sohu.com', 993, 'SSL', 'smtp.sohu.com', 465, 'SSL', '搜狐请用独立密码'],
  // China Mobile 139 — needs a client password.
  '139.com': ['imap.139.com', 993, 'SSL', 'smtp.139.com', 465, 'SSL', '139 请用客户端密码'],
  // China Telecom 189 — enable IMAP/SMTP service in webmail first; login password works.
  '189.cn': ['imap.189.cn', 993, 'SSL', 'smtp.189.cn', 465, 'SSL', '189 请先在网页设置里开启 IMAP/SMTP 服务'],
  // Alibaba Aliyun mail — login password works directly.
  'aliyun.com': ['imap.aliyun.com', 993, 'SSL', 'smtp.aliyun.com', 465, 'SSL', '阿里云邮箱直接用登录密码'],
  // Naver — 2FA + app password mandatory since 2025-06; enable IMAP in settings first.
  'naver.com': ['imap.naver.com', 993, 'SSL', 'smtp.naver.com', 587, 'STARTTLS', 'Naver 须开启两步验证并用应用专用密码，并先在网页设置里开启 IMAP'],
  // Yangtian Machinery (heavycrusher.com) — mail.oqumail.com.
  'heavycrusher.com': ['mail.oqumail.com', 993, 'SSL', 'mail.oqumail.com', 587, 'STARTTLS', ''],
};

const EXMAIL: RawPreset = ['imap.exmail.qq.com', 993, 'SSL', 'smtp.exmail.qq.com', 465, 'SSL', ''];

function toPreset(p: RawPreset): Preset {
  return {
    imapHost: p[0], imapPort: p[1], imapSecure: p[2],
    smtpHost: p[3], smtpPort: p[4], smtpSecure: p[5],
    note: p[6] || '',
  };
}

export function allPresets(): Record<string, Preset & { label?: string }> {
  const out: Record<string, Preset & { label?: string }> = {};
  for (const [domain, p] of Object.entries(RAW)) out[domain] = toPreset(p);
  out.exmail = {
    label: '腾讯企业邮箱 (Exmail)',
    ...toPreset(EXMAIL),
  };
  return out;
}

export function resolvePreset(email: string): (Preset & { preset: string | null }) | null {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return null;
  const domain = String(email).slice(at + 1).toLowerCase();
  if (!domain) return null;
  if (RAW[domain]) return { ...toPreset(RAW[domain]), preset: domain };
  return {
    imapHost: 'imap.' + domain, imapPort: 993, imapSecure: 'SSL',
    smtpHost: 'smtp.' + domain, smtpPort: 465, smtpSecure: 'SSL',
    note: '', preset: null,
  };
}
