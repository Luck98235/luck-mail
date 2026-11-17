// 本地 mock 后端：仅供 `npm run smoke` 冒烟测试使用。
// 按 API_CONTRACT.md 的形状返回数据 + Socket.io 推送 new-mail，
// 用于验证 Vue 前端的请求路径/方法/字段与契约一致、以及 Socket.io → unreadCounts → 角标。
// 不部署、不连真实 IMAP。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server as SocketIOServer } from 'socket.io'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '../dist')

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }

function foldersFor(accountId) {
  const base = accountId * 10
  return [
    { id: base + 1, accountId, path: 'INBOX', name: '收件箱', type: 'inbox', unreadCount: accountId === 2 ? 1 : 0, totalCount: accountId === 2 ? 1 : 1 },
    { id: base + 2, accountId, path: '草稿箱', name: '草稿箱', type: 'drafts', unreadCount: 0, totalCount: 0 },
    { id: base + 3, accountId, path: '已发送', name: '已发送', type: 'sent', unreadCount: 0, totalCount: 1 },
    { id: base + 4, accountId, path: '已删除', name: '已删除', type: 'trash', unreadCount: 0, totalCount: 0 },
    { id: base + 5, accountId, path: '垃圾邮件', name: '垃圾邮件', type: 'spam', unreadCount: 0, totalCount: 0 }
  ]
}

export function createMockServer() {
  const log = [] // {method, path, body}
  let loggedIn = false
  let connections = 0
  let ioRef = null

  const accountsState = [
    { id: 1, email: 'zm235@163.com', displayName: '', imapHost: 'imap.163.com', imapPort: 993, imapSecure: 'SSL', smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: 'SSL', enabled: true, sortOrder: 0, status: 'online', unreadCount: 0, lastSyncAt: new Date().toISOString() },
    { id: 2, email: 'luck534@163.com', displayName: '', imapHost: 'imap.163.com', imapPort: 993, imapSecure: 'SSL', smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: 'SSL', enabled: true, sortOrder: 1, status: 'online', unreadCount: 1, lastSyncAt: new Date().toISOString() }
  ]
  const foldersState = { 1: foldersFor(1), 2: foldersFor(2) }

  const messages = [
    { id: 1, accountId: 1, accountEmail: 'zm235@163.com', folderId: 11, folderPath: 'INBOX', uid: 101, subject: '欢迎使用 Luck-Mail', from: 'admin@16636.net', fromName: '', to: ['zm235@163.com'], date: new Date().toISOString(), snippet: '这是一封 mock 邮件，用于冒烟测试。', isRead: true, hasAttachments: false, size: 120 },
    { id: 2, accountId: 2, accountEmail: 'luck534@163.com', folderId: 21, folderPath: 'INBOX', uid: 201, subject: '未读测试邮件', from: 'admin@16636.net', fromName: '', to: ['luck534@163.com'], date: new Date().toISOString(), snippet: '这封是未读的。', isRead: false, hasAttachments: false, size: 130 },
    { id: 3, accountId: 1, accountEmail: 'zm235@163.com', folderId: 13, folderPath: '已发送', uid: 102, subject: '已发送的邮件', from: 'zm235@163.com', fromName: '', to: ['zm235@163.com'], date: new Date().toISOString(), snippet: '已发送。', isRead: true, hasAttachments: false, size: 90 }
  ]

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    let raw = ''
    req.on('data', (c) => { raw += c })
    await new Promise((r) => req.on('end', r))
    let body = null
    const ct = req.headers['content-type'] || ''
    if (raw && ct.includes('application/json')) { try { body = JSON.parse(raw) } catch { body = null } }
    if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) {
      log.push({ method: req.method, path: url.pathname + url.search, body, raw: raw.slice(0, 500) })
    }
    const send = (code, obj, headers = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
      res.end(JSON.stringify(obj))
    }
    const authed = (req.headers.cookie || '').includes('lm_session=mock')

    // ---- /api/* ----
    if (url.pathname === '/api/auth/status') return send(200, { ok: true, setupRequired: false, loggedIn: authed, username: authed ? 'tester' : undefined })
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      if (body?.password !== 'correct-password') return send(401, { ok: false, error: '用户名或密码错误' })
      loggedIn = true
      return send(200, { ok: true, username: body?.username }, { 'Set-Cookie': 'lm_session=mock; Path=/; HttpOnly; SameSite=Lax' })
    }
    if (url.pathname === '/api/auth/setup' && req.method === 'POST') return send(201, { ok: true })
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { loggedIn = false; return send(200, { ok: true }) }
    if (url.pathname === '/api/auth/change-password' && req.method === 'POST') return send(200, { ok: true })
    if (url.pathname === '/api/accounts' && req.method === 'GET') {
      return send(200, { ok: true, accounts: accountsState })
    }
    if (url.pathname === '/api/accounts' && req.method === 'POST') return send(201, { ok: true, account: { id: 3, ...body, status: 'online', unreadCount: 0 } })
    const acctMatch = url.pathname.match(/^\/api\/accounts\/(\d+)\/(folders|test|refresh)$/)
    if (acctMatch && req.method === 'GET') return send(200, { ok: true, folders: foldersState[Number(acctMatch[1])] || [] })
    if (acctMatch) return send(200, { ok: true, imapOk: true, smtpOk: true })
    if (url.pathname === '/api/refresh-all' && req.method === 'POST') return send(200, { ok: true })
    const presetMatch = url.pathname.match(/^\/api\/presets\/(.+)$/)
    if (presetMatch && req.method === 'GET') {
      const domain = decodeURIComponent(presetMatch[1])
      if (domain === '163.com') return send(200, { ok: true, preset: { imapHost: 'imap.163.com', imapPort: 993, imapSecure: 'SSL', smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: 'SSL', note: '网易 163 邮箱' }, note: '网易 163 邮箱' })
      return send(200, { ok: true, preset: null, note: '', imapHost: `imap.${domain}`, imapPort: 993, imapSecure: 'SSL', smtpHost: `smtp.${domain}`, smtpPort: 465, smtpSecure: 'SSL' })
    }
    if (url.pathname === '/api/settings' && req.method === 'GET') return send(200, { ok: true, settings: { signature: '', defaultAccountId: 1 } })
    if (url.pathname === '/api/settings' && req.method === 'PUT') return send(200, { ok: true })
    if (url.pathname === '/api/messages' && req.method === 'GET') {
      const view = url.searchParams.get('view') || 'all-inbox'
      const accountId = url.searchParams.get('accountId')
      const folderId = url.searchParams.get('folderId')
      const q = (url.searchParams.get('q') || '').toLowerCase()
      let list = [...messages]
      if (view === 'all-inbox') list = list.filter((m) => m.folderPath === 'INBOX')
      else if (view === 'all-unread') list = list.filter((m) => !m.isRead)
      else if (view === 'all-sent') list = list.filter((m) => m.folderPath === '已发送')
      else if (view === 'all-drafts') list = list.filter((m) => m.folderPath === '草稿箱')
      else if (view === 'all-trash') list = list.filter((m) => m.folderPath === '已删除')
      else if (view === 'folder') list = list.filter((m) => String(m.accountId) === accountId && String(m.folderId) === folderId)
      if (accountId && view === 'all-unread') list = list.filter((m) => String(m.accountId) === accountId)
      if (q) list = list.filter((m) => (m.subject + m.from + m.snippet).toLowerCase().includes(q))
      const offset = Number(url.searchParams.get('offset') || 0)
      const limit = Number(url.searchParams.get('limit') || 50)
      return send(200, { ok: true, messages: list.slice(offset, offset + limit), total: list.length })
    }
    const msgMatch = url.pathname.match(/^\/api\/messages\/(\d+)(\/read)?$/)
    if (msgMatch && req.method === 'GET') {
      const m = messages.find((x) => x.id === Number(msgMatch[1]))
      if (!m) return send(404, { ok: false, error: '邮件不存在' })
      m.isRead = true // 契约：打开即标已读
      return send(200, { ok: true, message: { ...m, cc: [], bodyText: m.snippet, bodyHtml: `<p>${m.snippet}</p>`, attachments: [] } })
    }
    if (msgMatch && req.method === 'POST') {
      const m = messages.find((x) => x.id === Number(msgMatch[1]))
      if (m && body) m.isRead = !!body.read
      return send(200, { ok: true })
    }
    if (msgMatch && req.method === 'DELETE') {
      const idx = messages.findIndex((x) => x.id === Number(msgMatch[1]))
      if (idx >= 0) messages.splice(idx, 1)
      return send(200, { ok: true })
    }
    if (url.pathname === '/api/messages/send' && req.method === 'POST') return send(201, { ok: true, id: 99, messageId: '<mock@local>' })

    // ---- 静态文件（dist，SPA fallback） ----
    let file = path.join(DIST, url.pathname === '/' || url.pathname === '/login' ? 'index.html' : decodeURIComponent(url.pathname))
    if (!file.startsWith(DIST)) { res.writeHead(403); return res.end() }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(DIST, 'index.html')
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
    fs.createReadStream(file).pipe(res)
  })

  const io = new SocketIOServer(server, { path: '/socket.io/' })
  ioRef = io
  io.on('connection', (socket) => {
    connections += 1
    // 模拟：163 邮箱收到新邮件，800ms 后推 new-mail
    setTimeout(() => {
      const fresh = { id: 99, accountId: 2, accountEmail: 'luck534@163.com', folderId: 21, folderPath: 'INBOX', uid: 299, subject: 'Socket.io 新邮件', from: 'new@example.com', fromName: '', to: ['luck534@163.com'], date: new Date().toISOString(), snippet: '这是一封 Socket.io 推送的新邮件。', isRead: false, hasAttachments: false, size: 100 }
      messages.unshift(fresh)
      // 服务端状态跟着涨：账号与文件夹未读数 +1（与真实后端一致）
      accountsState.find((a) => a.id === 2).unreadCount += 1
      foldersState[2].find((f) => f.id === 21).unreadCount += 1
      socket.emit('new-mail', { accountId: 2, folderId: 21, message: fresh })
    }, 800)
  })

  return {
    log,
    messages,
    get connections() { return connections },
    get loggedIn() { return loggedIn },
    emitNewMail(payload) { ioRef.emit('new-mail', payload) },
    start(port = 0) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)))
    },
    close() { return new Promise((resolve) => { try { io.close() } catch { /* 忽略 */ } server.close(() => resolve()) }) }
  }
}
