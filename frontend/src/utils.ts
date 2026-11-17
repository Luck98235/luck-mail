// 展示用小工具：时间、头像首字母/配色、附件大小
export function fmtListTime(iso: string | undefined | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  if (sameDay) return d.toTimeString().slice(0, 5)
  const y = new Date(now); y.setDate(now.getDate() - 1)
  if (d.toDateString() === y.toDateString()) return '昨天'
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function fmtFullTime(iso: string | undefined | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function initialOf(text: string | undefined | null): string {
  const t = (text || '?').trim()
  return t.charAt(0).toUpperCase()
}

// 邮箱域名 → 品牌色（头像圆用；163 红、QQ 蓝等，仅展示）
const DOMAIN_COLORS: Record<string, string> = {
  '163.com': '#ef4444', '126.com': '#ef4444', 'yeah.net': '#ef4444', '188.com': '#ef4444',
  'qq.com': '#3b82f6', 'foxmail.com': '#3b82f6',
  'gmail.com': '#ea4335', 'outlook.com': '#0078d4', 'hotmail.com': '#0078d4',
  'aliyun.com': '#ff6a00', 'sina.com': '#e6162d', 'sohu.com': '#fdbd00',
  '139.com': '#e60012', '189.cn': '#00a0e9'
}
export function domainColor(email: string): string {
  const domain = (email || '').split('@')[1] || ''
  return DOMAIN_COLORS[domain] || '#64748b'
}
export function domainShort(email: string): string {
  const domain = (email || '').split('@')[1] || ''
  if (domain === '163.com') return '163'
  if (domain === 'qq.com') return 'QQ'
  if (domain === 'gmail.com') return 'Gm'
  return domain.split('.')[0].slice(0, 2) || '?'
}

export function formatSize(n: number | null | undefined): string {
  if (n == null) return ''
  if (n < 1024) return n + ' B'
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
  return (n / 1024 / 1024).toFixed(1) + ' MB'
}
