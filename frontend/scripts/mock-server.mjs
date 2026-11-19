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
  let deleteShouldFail = false // 冒烟测试开关：打开后 DELETE /api/messages/:id 一律 500（行仍在）
  let deleteFailError = '' // 冒烟测试开关：DELETE 失败时返回的 error 文本（审计 #19 LOW-1：SQLite 内部错误须映射成友好文案）；空时用默认“删除失败，请重试”
  let deleteStatusResult = null // 冒烟测试开关：设置后 GET /api/messages/delete-status 返回该结算结果（审计 #19 MED-1：批量删除结算须读 failed 字段）
  let draftCreateShouldFail = false // 冒烟测试开关：打开后 POST /api/drafts 一律 500（审计 #14 BLOCKER 保存失败路径）
  let draftDeleteFailIds = new Set() // 冒烟测试开关：DELETE /api/drafts/:id 对这些 id 一律 500、草稿不删（审计 #20 LOW-1：异步批量删除结算须计草稿失败）
  let holdMessages = false // 冒烟测试开关：打开后 GET /api/messages 的响应先挂起，等 releaseHeldMessages() 再发（审计 #18 MED-1 过期响应复活回归）
  let accountsDelayMs = 0 // 冒烟测试开关：GET /api/accounts 延迟响应（审计 #22 LOW-1：拉宽重登 init 的 await 窗口，复现退出重登后闪空态）
  const heldMessages = [] // 待放行的列表响应回调

  const accountsState = [
    { id: 1, email: 'zm235@163.com', displayName: '', imapHost: 'imap.163.com', imapPort: 993, imapSecure: 'SSL', smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: 'SSL', enabled: true, sortOrder: 0, status: 'online', unreadCount: 0, lastSyncAt: new Date().toISOString() },
    { id: 2, email: 'luck534@163.com', displayName: '', imapHost: 'imap.163.com', imapPort: 993, imapSecure: 'SSL', smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: 'SSL', enabled: true, sortOrder: 1, status: 'online', unreadCount: 1, lastSyncAt: new Date().toISOString() }
  ]
  const foldersState = { 1: foldersFor(1), 2: foldersFor(2) }

  const messages = [
    { id: 1, accountId: 1, accountEmail: 'zm235@163.com', folderId: 11, folderPath: 'INBOX', uid: 101, subject: '欢迎使用 Luck-Mail', from: 'admin@16636.net', fromName: '', to: ['zm235@163.com'], date: new Date().toISOString(), snippet: '这是一封 mock 邮件，用于冒烟测试。', isRead: true, hasAttachments: false, size: 120 },
    { id: 2, accountId: 2, accountEmail: 'luck534@163.com', folderId: 21, folderPath: 'INBOX', uid: 201, subject: '未读测试邮件', from: 'admin@16636.net', fromName: '', to: ['luck534@163.com'], date: new Date().toISOString(), snippet: '这封是未读的。', isRead: false, hasAttachments: false, size: 130, messageId: '<msg2@local>', references: ['<ref1@local>'], replyTo: 'reply-to@example.com' },
    { id: 3, accountId: 1, accountEmail: 'zm235@163.com', folderId: 13, folderPath: '已发送', uid: 102, subject: '已发送的邮件', from: 'zm235@163.com', fromName: '', to: ['zm235@163.com'], date: new Date().toISOString(), snippet: '已发送。', isRead: true, hasAttachments: false, size: 90 },
    // IMAP 草稿（2026-11-19 回归：草稿视图须把它与服务端草稿合并显示）
    { id: 4, accountId: 1, accountEmail: 'zm235@163.com', folderId: 12, folderPath: '草稿箱', uid: 103, subject: 'IMAP 草稿测试', from: 'zm235@163.com', fromName: '', to: ['zm235@163.com'], date: new Date().toISOString(), snippet: '邮箱同步来的草稿。', isRead: true, hasAttachments: false, size: 80 },
    // 审计 #16 MED-1：已发送双行种子——同收件人一对（应合并成 1 行）、
    // 不同收件人一对（应都显示）、一行缺 to 的旧行（主题与其他行都不同、
    // 无可合并配对，须正常显示、不被去重吞掉；后端跳过收件人比对的语义
    // 见 engine.ts，缺 to 本身不阻止合并，所以这里不用同主题配对）。
    { id: 10, accountId: 1, accountEmail: 'zm235@163.com', folderId: 13, folderPath: '已发送', uid: 110, subject: '去重测试同收件人', from: 'zm235@163.com', fromName: '', to: ['b@example.com'], date: '2026-11-18T10:00:00.000Z', snippet: '双生副本 A。', isRead: true, hasAttachments: false, size: 100 },
    { id: 11, accountId: 1, accountEmail: 'zm235@163.com', folderId: 13, folderPath: '已发送', uid: 111, subject: '去重测试同收件人', from: 'zm235@163.com', fromName: '', to: ['b@example.com'], date: '2026-11-18T10:00:05.000Z', snippet: '双生副本 B。', isRead: true, hasAttachments: false, size: 150 },
    { id: 12, accountId: 1, accountEmail: 'zm235@163.com', folderId: 13, folderPath: '已发送', uid: 112, subject: '去重测试不同收件人', from: 'zm235@163.com', fromName: '', to: ['c@example.com'], date: '2026-11-18T10:00:00.000Z', snippet: '发给 C。', isRead: true, hasAttachments: false, size: 100 },
    { id: 13, accountId: 1, accountEmail: 'zm235@163.com', folderId: 13, folderPath: '已发送', uid: 113, subject: '去重测试不同收件人', from: 'zm235@163.com', fromName: '', to: ['d@example.com'], date: '2026-11-18T10:00:05.000Z', snippet: '发给 D。', isRead: true, hasAttachments: false, size: 150 },
    // 缺 to 的旧行：没有 to 字段；主题与其他行都不同，无可合并配对，须正常显示。
    { id: 14, accountId: 1, accountEmail: 'zm235@163.com', folderId: 13, folderPath: '已发送', uid: 114, subject: '缺收件人旧行', from: 'zm235@163.com', fromName: '', date: '2026-11-18T10:00:00.000Z', snippet: '旧行没有收件人信息。', isRead: true, hasAttachments: false, size: 100 }
  ]

  // 服务端草稿内存态（仅供冒烟测试；真实后端存数据库）
  // 预置一条 id=4 的服务端草稿：与 IMAP 草稿消息 id 4 撞号（审计 #11 B1 回归）——
  // 草稿视图里两者须同时存在、各自点开正确；draftSeq 从 5 起，避免新草稿再撞 4。
  // 审计 #12 M4：对外返回的草稿形状须与真实后端一致——真实后端
  // publicDraft 把库里的 references 空格串 split 成数组、cc 返回数组
  //（draftRoutes.ts）；以前 mock 原样回显 POST 的字符串，前端在冒烟里
  // 永远走不到数组分支，B1 的崩溃漏网。内存里仍按 POST 原样存（字符串），
  // 只在返回时归一化。
  function publicDraft(d) {
    return {
      ...d,
      references: typeof d.references === 'string'
        ? (d.references.split(/\s+/).filter(Boolean).length ? d.references.split(/\s+/).filter(Boolean) : null)
        : (Array.isArray(d.references) && d.references.length ? d.references : null),
      cc: Array.isArray(d.cc) ? d.cc : [],
    }
  }
  let draftSeq = 5
  const drafts = [
    { id: 4, accountId: 1, to: 'a@example.com', subject: '服务端草稿撞号测试', text: '这条服务端草稿的 id 是 4。', idempotencyKey: 'mock-key-seed-4', updatedAt: new Date().toISOString() }
  ]
  // 审计 #13 MED-2：预置 55 封旧草稿（服务端草稿共 56 封 > 50），验证第 51 封
  // 起在草稿视图第 2 页仍可见；updatedAt 按 i 递减（055 最旧），保证排在
  // 测试新建的草稿之后；主题不含“撞号”，不干扰 L14 搜索断言。
  for (let i = 1; i <= 55; i++) {
    drafts.push({ id: 1000 + i, accountId: 1, to: 'a@example.com', subject: `旧草稿填充测试 ${String(i).padStart(3, '0')}`, text: '填充草稿', idempotencyKey: `mock-key-seed-${1000 + i}`, updatedAt: new Date(Date.UTC(2025, 11, 1) - i * 86400000).toISOString() })
  }
  // 审计 #16 LOW-1：多词/深正文命中种子——主题含“发票”、正文 80 字之后
  // 才出现“2026”；旧版整句 includes + 只看 snippet 前 80 字搜不到它。
  // updatedAt 取 2025-11-01（比填充草稿旧），不干扰第 1 页顺序与 MED-2 计数外的断言。
  drafts.push({ id: 2000, accountId: 1, to: 'a@example.com', subject: '发票申请', text: '这是发票申请草稿，正文很长，前面都是与查询词无关的填充文字，用来把目标词顶到摘要截断位置之后，填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充填充。2026年度报销。', idempotencyKey: 'mock-key-seed-2000', updatedAt: '2025-11-01T00:00:00.000Z' })

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
      return send(200, { ok: true, username: body?.username }, { 'Set-Cookie': 'lm_session=mock; Path=/; HttpOnly; SameSite=Strict' })
    }
    if (url.pathname === '/api/auth/setup' && req.method === 'POST') return send(201, { ok: true })
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') { loggedIn = false; return send(200, { ok: true }) }
    if (url.pathname === '/api/auth/change-password' && req.method === 'POST') return send(200, { ok: true })
    if (url.pathname === '/api/accounts' && req.method === 'GET') {
      if (accountsDelayMs > 0) { setTimeout(() => send(200, { ok: true, accounts: accountsState }), accountsDelayMs); return }
      return send(200, { ok: true, accounts: accountsState })
    }
    if (url.pathname === '/api/accounts' && req.method === 'POST') return send(201, { ok: true, account: { id: 3, ...body, status: 'online', unreadCount: 0 } })
    const acctMatch = url.pathname.match(/^\/api\/accounts\/(\d+)\/(folders|test|refresh)$/)
    if (acctMatch && req.method === 'GET') return send(200, { ok: true, folders: foldersState[Number(acctMatch[1])] || [] })
    if (acctMatch) return send(200, { ok: true, imapOk: true, smtpOk: true })
    // 取邮箱明文密码只接受 POST（审计 #10 后端约定；GET 一律 405）。
    const pwMatch = url.pathname.match(/^\/api\/accounts\/(\d+)\/password$/)
    if (pwMatch && req.method === 'POST') return send(200, { ok: true, password: 'mock-password' })
    if (pwMatch) return send(405, { ok: false, error: 'Method Not Allowed' })
    if (url.pathname === '/api/refresh-all' && req.method === 'POST') return send(200, { ok: true })
    const presetMatch = url.pathname.match(/^\/api\/presets\/(.+)$/)
    if (presetMatch && req.method === 'GET') {
      const domain = decodeURIComponent(presetMatch[1])
      if (domain === '163.com') return send(200, { ok: true, preset: { imapHost: 'imap.163.com', imapPort: 993, imapSecure: 'SSL', smtpHost: 'smtp.163.com', smtpPort: 465, smtpSecure: 'SSL', note: '网易 163 邮箱' }, note: '网易 163 邮箱' })
      return send(200, { ok: true, preset: null, note: '', imapHost: `imap.${domain}`, imapPort: 993, imapSecure: 'SSL', smtpHost: `smtp.${domain}`, smtpPort: 465, smtpSecure: 'SSL' })
    }
    if (url.pathname === '/api/settings' && req.method === 'GET') return send(200, { ok: true, settings: { signature: '', defaultAccountId: 1 } })
    if (url.pathname === '/api/settings' && req.method === 'PUT') return send(200, { ok: true })
    // ---- 服务端草稿（内存态，仅供冒烟测试走通 drafts 接口路径）----
    if (url.pathname === '/api/drafts' && req.method === 'GET') {
      // 审计 #13 MED-2：按真实后端契约支持 limit/offset 分页并回 total。
      const sorted = [...drafts].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      const offset = Number(url.searchParams.get('offset') || 0)
      const limit = Number(url.searchParams.get('limit') || 50)
      return send(200, { ok: true, drafts: sorted.slice(offset, offset + limit).map(publicDraft), total: sorted.length })
    }
    if (url.pathname === '/api/drafts' && req.method === 'POST') {
      // 审计 #14 BLOCKER 保存失败路径：开关打开时一律 500，草稿不入库，
      // 前端点“存草稿”后弹窗须不关闭且显示失败提示。
      if (draftCreateShouldFail) return send(500, { ok: false, error: '草稿保存失败，请重试' })
      // 审计 #11 H1/L15：草稿契约带 inReplyTo/references/cc，存进内存态，
      // GET /api/drafts 再原样返回（重开草稿时前端能回填）。
      const d = { id: draftSeq++, accountId: body?.accountId ?? null, to: body?.to || '', subject: body?.subject || '', text: body?.text || '', inReplyTo: body?.inReplyTo || undefined, references: body?.references || undefined, cc: Array.isArray(body?.cc) ? body.cc : [], idempotencyKey: body?.idempotencyKey || `mock-key-${Date.now()}`, updatedAt: new Date().toISOString() }
      drafts.unshift(d)
      return send(200, { ok: true, draft: publicDraft(d) })
    }
    const draftMatch = url.pathname.match(/^\/api\/drafts\/(\d+)$/)
    if (draftMatch && req.method === 'PUT') {
      const d = drafts.find((x) => String(x.id) === draftMatch[1])
      if (!d) return send(404, { ok: false, error: '草稿不存在' })
      if (body?.accountId !== undefined) d.accountId = body.accountId
      if (body?.to !== undefined) d.to = body.to
      if (body?.subject !== undefined) d.subject = body.subject
      if (body?.text !== undefined) d.text = body.text
      if (body?.inReplyTo !== undefined) d.inReplyTo = body.inReplyTo
      if (body?.references !== undefined) d.references = body.references
      if (body?.cc !== undefined) d.cc = body.cc
      d.updatedAt = new Date().toISOString()
      return send(200, { ok: true, draft: publicDraft(d) })
    }
    if (draftMatch && req.method === 'DELETE') {
      // 审计 #20 LOW-1：开关命中的 id 一律 500、草稿不删（冒烟断言结算 toast 含失败数）。
      if (draftDeleteFailIds.has(draftMatch[1])) return send(500, { ok: false, error: '草稿删除失败，请重试' })
      const idx = drafts.findIndex((x) => String(x.id) === draftMatch[1])
      if (idx >= 0) drafts.splice(idx, 1)
      return send(200, { ok: true })
    }
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
      const payload = { ok: true, messages: list.slice(offset, offset + limit), total: list.length }
      // 审计 #18 MED-1：挂起时先按请求时刻的快照算好 payload 再挂起——
      // 放行时发的是旧快照（含已被删的信），才能复现“过期响应复活已删行”。
      if (holdMessages) { heldMessages.push(() => send(200, payload)); return }
      return send(200, payload)
    }
    const msgMatch = url.pathname.match(/^\/api\/messages\/(\d+)(\/read)?$/)
    if (msgMatch && req.method === 'GET') {
      const m = messages.find((x) => x.id === Number(msgMatch[1]))
      if (!m) return send(404, { ok: false, error: '邮件不存在' })
      // 注意：GET 详情不再带标已读副作用（审计 #9 真实后端行为）——未读信
      // 由前端显式调 POST /read；mock 这里不改 isRead，否则 setRead 相关
      // 的前端逻辑（审计 #11 M7：所有未读里打开后离列）在冒烟里永远走不到。
      // bodyHtml 透传（消毒回归测试用）：测试可往 messages 里推一封带恶意
      // bodyHtml 的信，验证前端第二遍消毒；平时仍按 snippet 生成。
      // 审计 #11 H1/L23：详情返回 threading 字段（messageId/references/replyTo），
      // 回复时前端据此填 In-Reply-To/References/收件人。
      return send(200, { ok: true, message: { ...m, cc: [], bodyText: m.snippet, bodyHtml: m.bodyHtml || `<p>${m.snippet}</p>`, attachments: m.attachments || [], messageId: m.messageId || `<mock-${m.id}@local>`, references: m.references || [], replyTo: m.replyTo || undefined } })
    }
    if (msgMatch && req.method === 'POST') {
      const m = messages.find((x) => x.id === Number(msgMatch[1]))
      if (m && body) m.isRead = !!body.read
      return send(200, { ok: true })
    }
    if (msgMatch && req.method === 'DELETE') {
      // 冒烟测试的“删除返回错误”分支（F13）：行仍在、不发 Socket.io 事件，
      // 由 smoke.mjs 用 setDeleteFail(true) 打开、用完再关。
      if (deleteShouldFail) return send(500, { ok: false, error: deleteFailError || '删除失败，请重试' })
      const idx = messages.findIndex((x) => x.id === Number(msgMatch[1]))
      if (idx >= 0) messages.splice(idx, 1)
      return send(200, { ok: true })
    }
    // 审计 #17 LOW-1：移信接口（前端 moveToSpam/moveToInbox 调它）——
    // 更新信件的文件夹归属；未读信移出源文件夹 -1、移入目标文件夹 +1，
    // 账号未读数按文件夹之和重算（与真实后端 refreshFolderCounts 一致）。
    const moveMatch = url.pathname.match(/^\/api\/messages\/(\d+)\/move$/)
    if (moveMatch && req.method === 'POST') {
      const m = messages.find((x) => x.id === Number(moveMatch[1]))
      if (!m) return send(404, { ok: false, error: '邮件不存在' })
      const target = Object.values(foldersState).flat().find((f) => f.id === body?.folderId)
      if (target) {
        if (!m.isRead) {
          const src = (foldersState[m.accountId] || []).find((f) => f.id === m.folderId)
          if (src) src.unreadCount = Math.max(0, (src.unreadCount || 0) - 1)
          target.unreadCount = (target.unreadCount || 0) + 1
          const acct = accountsState.find((a) => a.id === m.accountId)
          if (acct) acct.unreadCount = (foldersState[m.accountId] || []).reduce((s, x) => s + (x.unreadCount || 0), 0)
        }
        m.folderId = target.id
        m.folderPath = target.path
      }
      return send(200, { ok: true })
    }
    if (url.pathname === '/api/messages/send' && req.method === 'POST') {
      // 发信成功后服务端按 draftId 自动删草稿（JSON 发信时 body 里有 draftId；
      // multipart 发信 mock 不解析，删草稿走不到，冒烟只覆盖 JSON 路径）。
      if (body?.draftId != null) {
        const di = drafts.findIndex((x) => String(x.id) === String(body.draftId))
        if (di >= 0) drafts.splice(di, 1)
      }
      // 发信成功后把已发送副本记进 mock 数据：前端切到所有已发送后能看到它，
      // 再按 201 返回的 id 打开（F2 的 openMessage(sent.id) 走 GET /api/messages/100）。
      // id 用 100，避免与 Socket.io 推送的新邮件（id 99）撞号。
      const sent = { id: 100, accountId: 1, accountEmail: 'zm235@163.com', folderId: 13, folderPath: '已发送', uid: 103, subject: body?.subject || '（无主题）', from: 'zm235@163.com', fromName: '', to: Array.isArray(body?.to) ? body.to : [body?.to || 'a@example.com'], date: new Date().toISOString(), snippet: body?.text || '', isRead: true, hasAttachments: false, size: 90 }
      const existing = messages.findIndex((x) => x.id === 100)
      if (existing >= 0) messages[existing] = sent
      else messages.push(sent)
      return send(201, { ok: true, id: 100, messageId: '<mock@local>' })
    }
    // 审计 #19 MED-1：批量删除一律走异步返回 taskId，结算走 delete-status
    // 轮询；deleteStatusResult 由 smoke.mjs 设置结算结果（deleted/failed），
    // 未设置时默认全部成功（deleted:0、failed:[]）。
    if (url.pathname === '/api/messages/batch-delete' && req.method === 'POST') {
      return send(200, { ok: true, taskId: 'mock-task-1', status: 'running' })
    }
    if (url.pathname === '/api/messages/delete-status' && req.method === 'GET') {
      const r = deleteStatusResult || { total: 0, deleted: 0, failed: [] }
      return send(200, { ok: true, running: false, total: r.total ?? 0, deleted: r.deleted ?? 0, failed: r.failed ?? [], startedAt: Date.now(), view: null })
    }

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
      const fresh = { id: 99, accountId: 2, accountEmail: 'luck534@163.com', folderId: 21, folderPath: 'INBOX', uid: 299, subject: 'Socket.io 新邮件', from: 'new@example.com', fromName: '', to: ['luck534@163.com'], date: new Date().toISOString(), snippet: '这是一封 Socket.io 推送的新邮件。', isRead: false, hasAttachments: false, size: 100, replyTo: 'reply-to@example.com' }
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
    setDeleteFail(v, error) { deleteShouldFail = !!v; deleteFailError = typeof error === 'string' ? error : '' },
    setDeleteStatusResult(v) { deleteStatusResult = v },
    setDraftCreateFail(v) { draftCreateShouldFail = !!v },
    setDraftDeleteFailIds(ids) { draftDeleteFailIds = new Set((Array.isArray(ids) ? ids : []).map(String)) },
    // 审计 #18 MED-1：挂起 GET /api/messages 的响应（快照按请求时刻算），
    // releaseHeldMessages() 按挂起顺序一次放行全部。
    setHoldMessages(v) { holdMessages = !!v },
    // 审计 #22 LOW-1：延迟 GET /api/accounts 的响应（毫秒），拉宽重登 init
    // 的 await 窗口；用完调回 0。
    setAccountsDelayMs(ms) { accountsDelayMs = Math.max(0, Number(ms) || 0) },
    releaseHeldMessages() { const q = heldMessages.splice(0); q.forEach((fn) => fn()) },
    get connections() { return connections },
    get loggedIn() { return loggedIn },
    emitNewMail(payload) { ioRef.emit('new-mail', payload) },
    emitMailDeleted(payload) { ioRef.emit('mail-deleted', payload) },
    // 审计 #13 MED-1：模拟后端 mail-updated 回声（本标签页自己标已读后，
    // 后端广播给含发起方在内的全部 socket）。
    emitMailUpdated(payload) { ioRef.emit('mail-updated', payload) },
    // 冒烟测试：模拟服务端文件夹未读数变化（保持账号=文件夹之和的服务端等式，
    // 与真实后端 publicAccount 的 SUM(folders.unread_count) 一致）。
    setFolderUnread(accountId, folderId, unread) {
      const f = (foldersState[accountId] || []).find((x) => x.id === folderId)
      if (f) f.unreadCount = unread
      const acct = accountsState.find((a) => a.id === accountId)
      if (acct) acct.unreadCount = (foldersState[accountId] || []).reduce((s, x) => s + (x.unreadCount || 0), 0)
    },
    // 审计 #17 LOW-2：只改文件夹快照的未读数、不动账号端点值——模拟两次
    // 读数之间隔了一次同步、两路暂时对不上的情形；用完须调 setFolderUnread
    // 恢复一致（或直接结束测试，mock 随进程丢弃）。
    setFoldersUnreadSkew(accountId, folderId, unread) {
      const f = (foldersState[accountId] || []).find((x) => x.id === folderId)
      if (f) f.unreadCount = unread
    },
    start(port = 0) {
      return new Promise((resolve) => server.listen(port, () => resolve(server.address().port)))
    },
    close() { return new Promise((resolve) => { try { io.close() } catch { /* 忽略 */ } server.close(() => resolve()) }) }
  }
}
