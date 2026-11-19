// 契约一致性检查：直接调 mock 后端的每个接口，断言返回形状与 API_CONTRACT.md 一致
//（请求路径/方法/字段与前端 api.js 逐项对照；前端侧的调用另由 smoke.mjs 的请求日志断言）。
// 用法：npm run test:api-contract
import { createMockServer } from './mock-server.mjs'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

async function main() {
  const mock = createMockServer()
  const port = await mock.start(0)
  const base = `http://127.0.0.1:${port}`
  const j = async (path, opts = {}) => {
    const r = await fetch(base + path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } })
    const data = await r.json().catch(() => null)
    return { status: r.status, data }
  }

  let r = await j('/api/auth/status')
  check('GET /api/auth/status → {ok, setupRequired, loggedIn}', r.status === 200 && r.data.ok === true && typeof r.data.setupRequired === 'boolean' && typeof r.data.loggedIn === 'boolean')

  r = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'tester', password: 'correct-password' }) })
  check('POST /api/auth/login → 200 {ok, username} + Set-Cookie', r.status === 200 && r.data.ok === true && typeof r.data.username === 'string')

  r = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'tester', password: 'wrong' }) })
  check('POST /api/auth/login 错密码 → 401 {ok:false, error}', r.status === 401 && r.data.ok === false && typeof r.data.error === 'string')

  r = await j('/api/presets/163.com')
  check('GET /api/presets/163.com → preset{imapHost,imapPort,imapSecure,smtpHost,smtpPort,smtpSecure}', r.data.ok === true && r.data.preset?.imapHost === 'imap.163.com' && r.data.preset?.imapSecure === 'SSL')

  r = await j('/api/presets/unknown.example')
  check('GET /api/presets/:domain 未知域名回落 imap./smtp.+domain', r.data.preset === null && r.data.imapHost === 'imap.unknown.example')

  r = await j('/api/accounts')
  check('GET /api/accounts → accounts[] 含 id/email/status/unreadCount，且无密码字段', r.data.ok === true && Array.isArray(r.data.accounts) && r.data.accounts.every((a) => a.id && a.email && a.status && typeof a.unreadCount === 'number' && !('password' in a)))

  r = await j('/api/accounts/2/folders')
  check('GET /api/accounts/:id/folders → folders[] 含 id/accountId/path/name/type/unreadCount', r.data.ok === true && r.data.folders.every((f) => f.id && f.accountId && f.path && f.name && f.type && typeof f.unreadCount === 'number'))

  r = await j('/api/messages?view=all-inbox&limit=50&offset=0')
  check('GET /api/messages?view=all-inbox → {messages[], total}', r.data.ok === true && Array.isArray(r.data.messages) && typeof r.data.total === 'number')

  r = await j('/api/messages?view=folder&accountId=2&folderId=21')
  check('GET /api/messages?view=folder&accountId&folderId → 只返回该邮箱该文件夹', r.data.ok === true && r.data.messages.every((m) => m.accountId === 2 && m.folderId === 21))

  r = await j('/api/messages?view=all-unread&q=未读')
  check('GET /api/messages?q= 全文搜索参数被接受', r.data.ok === true && r.data.messages.every((m) => !m.isRead))

  r = await j('/api/messages/1')
  check('GET /api/messages/:id → message 含 bodyText/bodyHtml/attachments', r.data.ok === true && typeof r.data.message.bodyHtml === 'string' && Array.isArray(r.data.message.attachments))

  r = await j('/api/messages/1/read', { method: 'POST', body: JSON.stringify({ read: true }) })
  check('POST /api/messages/:id/read {read} → 200', r.status === 200 && r.data.ok === true)

  r = await j('/api/messages/send', { method: 'POST', body: JSON.stringify({ accountId: 1, to: ['a@example.com'], subject: 't', text: 'hi' }) })
  check('POST /api/messages/send（JSON）→ 201 {ok, id, messageId}', r.status === 201 && r.data.ok === true && r.data.id != null)

  // 审计 #12 B1/M4：草稿 references 形状——真实后端 GET /api/drafts 返回
  // references 为 string[]（无则 null）、cc 为 string[]；以前 mock 原样
  // 回显 POST 的字符串，前端在冒烟里永远走不到数组分支，B1 漏网。
  // 这里 POST 时按前端 draftSnapshot 的做法传空格串，GET 回来须是数组。
  r = await j('/api/drafts', { method: 'POST', body: JSON.stringify({ accountId: 1, to: 'a@example.com', subject: '契约草稿', text: 'hi', inReplyTo: '<orig@local>', references: '<ref1@local> <orig@local>', cc: ['c@example.com'] }) })
  check('POST /api/drafts → 200 {ok, draft}', r.status === 200 && r.data.ok === true && r.data.draft?.id != null)
  r = await j('/api/drafts')
  const contractDraft = (r.data.drafts || []).find((d) => d.subject === '契约草稿')
  check('GET /api/drafts → references 为 string[]（不是空格串）', r.data.ok === true && Array.isArray(contractDraft?.references) && contractDraft.references.includes('<orig@local>'), JSON.stringify(contractDraft?.references))
  check('GET /api/drafts → cc 为 string[]、inReplyTo 为字符串', Array.isArray(contractDraft?.cc) && contractDraft.cc.includes('c@example.com') && contractDraft?.inReplyTo === '<orig@local>', JSON.stringify(contractDraft))

  r = await j('/api/settings')
  check('GET /api/settings → {settings:{signature, defaultAccountId}}', r.data.ok === true && 'signature' in r.data.settings && 'defaultAccountId' in r.data.settings)

  r = await j('/api/settings', { method: 'PUT', body: JSON.stringify({ signature: 's', defaultAccountId: 1 }) })
  check('PUT /api/settings → 200', r.status === 200 && r.data.ok === true)

  r = await j('/api/accounts/2/password', { method: 'POST' })
  check('POST /api/accounts/:id/password → 200 {ok, password}（审计 #10：明文密码只走 POST）', r.status === 200 && r.data.ok === true && typeof r.data.password === 'string')

  r = await j('/api/accounts/2/password')
  check('GET /api/accounts/:id/password → 405（GET 不再接受）', r.status === 405)

  r = await j('/api/accounts/2/refresh', { method: 'POST' })
  check('POST /api/accounts/:id/refresh → 200', r.status === 200 && r.data.ok === true)

  r = await j('/api/refresh-all', { method: 'POST' })
  check('POST /api/refresh-all → 200', r.status === 200 && r.data.ok === true)

  r = await j('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ current: 'old12345', next: 'new12345' }) })
  check('POST /api/auth/change-password {current, next} → 200', r.status === 200 && r.data.ok === true)

  await mock.close()
  const failed = results.filter((x) => !x.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) process.exit(1)
}

main().catch((e) => { console.error('异常：', e); process.exit(1) })
