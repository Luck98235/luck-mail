// 冒烟测试：用 jsdom 挂载 Vite 产物（dist/），对接 scripts/mock-server.mjs，验证：
//  1. 应用能挂载，登录页渲染（用户名/密码/小眼睛/30天免登录/登录按钮）
//  2. 登录成功进主界面，桌面 3 栏结构在（左栏/列表/阅读窗），关键按钮都在
//  3. 请求路径/方法/字段与契约一致（通过 mock 的请求日志断言）
//  4. 聚合视图 vs 单邮箱视图：所有未读调 view=all-unread（不带 accountId）；
//     点邮箱调 view=folder&accountId=&folderId=（收件箱文件夹）
//  5. Socket.io：连上后收到 new-mail，Pinia unreadCounts 更新，左栏红色角标 (1)->(2)，
//     新邮件进 mailList，无需刷新
//  6. 写信发送调 POST /api/messages/send；删除调 DELETE /api/messages/:id
//  7. 移动端 QQ 布局 DOM 在（账号总览：常用文件夹/我的邮箱；侧滑抽屉）
//  8. 主题：localStorage luck-mail-theme=green 时 body[data-theme=green]
// 注意：jsdom 不执行 <script type="module">，产物是单文件且无 import.meta，
// 所以这里把 bundle 以经典脚本 eval 进 jsdom（仅测试手段，不改产物）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, ResourceLoader } from 'jsdom'
import { createMockServer } from './mock-server.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.resolve(__dirname, '../dist')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

class LocalOnlyLoader extends ResourceLoader {
  fetch(url, options) {
    // 只放行同源资源（dist + mock API），CDN（Tailwind/FontAwesome）返回空，避免测试依赖外网
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) return super.fetch(url, options)
    return Promise.resolve(Buffer.from(''))
  }
}

async function waitFor(fn, timeout = 15000, label = '') {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try { const v = fn(); if (v) return v } catch { /* 继续等 */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`超时未出现：${label}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const mock = createMockServer()
  const port = await mock.start(0)
  const origin = `http://127.0.0.1:${port}`

  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  const bundleFile = fs.readdirSync(path.join(DIST, 'assets')).find((f) => f.endsWith('.js'))
  const bundle = fs.readFileSync(path.join(DIST, 'assets', bundleFile), 'utf8')
  // 去掉 module 脚本标签（jsdom 不执行，改为下面 eval 产物）
  const htmlNoModule = html.replace(/<script[^>]*type="module"[^>]*><\/script>/, '')

  const dom = new JSDOM(htmlNoModule, {
    url: `${origin}/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: new LocalOnlyLoader(),
    beforeParse(window) {
      // jsdom 窗口没有 fetch：注入 Node fetch，并把相对地址按当前 origin 解析
      window.fetch = (input, init) => fetch(new URL(input, window.location.href), init)
      // AbortController 也须注入 Node 的同款：应用代码用它做 30 秒超时，
      // jsdom 自带的 AbortSignal 传给 Node fetch 会抛 TypeError（跨实现不认），
      // 真浏览器里 fetch 与 AbortController 是同一套，不存在这个问题。
      window.AbortController = AbortController
      window.AbortSignal = AbortSignal
      // jsdom 没有 ResizeObserver：阅读窗用它做 iframe 自适应高度，这里给个空实现即可
      window.ResizeObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} }
      try { window.localStorage.setItem('luck-mail-theme', 'green') } catch { /* 忽略 */ }
    }
  })
  const { window } = dom
  const { document } = window

  const q = (sel) => document.querySelector(sel)
  const qa = (sel) => [...document.querySelectorAll(sel)]
  const text = () => document.body.textContent || ''
  const setInput = (el, value) => {
    el.value = value
    el.dispatchEvent(new window.Event('input', { bubbles: true }))
  }
  const click = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))

  // 挂载应用（产物以经典脚本 eval）
  window.eval(bundle)

  // 1. 登录页渲染
  await waitFor(() => q('input[autocomplete="username"]'), 15000, '登录页用户名框')
  check('登录页渲染：用户名/密码框、登录按钮、30天内免登录', !!(
    q('input[autocomplete="username"]') && q('input[type="password"]') && text().includes('30天内免登录') && text().includes('登录')
  ))
  check('主题：localStorage luck-mail-theme=green 生效', document.body.getAttribute('data-theme') === 'green', document.body.getAttribute('data-theme'))

  // 2. 错误密码 → 友好提示（401）
  const userInput = q('input[autocomplete="username"]')
  const pwInput = q('input[type="password"]')
  setInput(userInput, 'tester')
  setInput(pwInput, 'wrong-password')
  click(q('button[type="submit"]'))
  await waitFor(() => text().includes('用户名或密码错误'), 10000, '登录失败提示')
  check('登录失败（401）友好提示', text().includes('用户名或密码错误'))

  // 3. 正确登录 → 主界面
  setInput(pwInput, 'correct-password')
  click(q('button[type="submit"]'))
  await waitFor(() => q('#btn-compose'), 15000, '主界面写信按钮')
  // 写信按钮一挂载就出现；账号/邮件是异步加载的，等账号列表渲染出来再断言
  await waitFor(() => q('#account-list')?.textContent.includes('zm235@163.com'), 15000, '账号列表加载')
  await waitFor(() => text().includes('欢迎使用 Luck-Mail'), 15000, '邮件列表加载')
  const layout = q('#desktop-layout')
  check('主界面 3 栏结构：左栏/列表/阅读窗', !!(
    layout && text().includes('Luck-Mail') && q('#btn-refresh-all') && q('#message-list, section') && text().includes('欢迎使用 Luck-Mail')
  ))
  check('聚合分类 5 项齐全', ['所有收件箱', '所有未读', '所有草稿', '所有已发送', '所有已删除'].every((s) => text().includes(s)))
  check('邮箱平铺无分组：两个账号在列，无“分组”入口', text().includes('zm235@163.com') && text().includes('luck534@163.com') && !text().includes('分组'))
  check('阅读窗自动打开第一封', text().includes('欢迎使用 Luck-Mail'))
  // 阅读窗详情是异步取的，等 iframe 的 srcdoc 里出现正文再断言
  const frame = await waitFor(() => {
    const f = q('iframe[title="邮件正文"]')
    return f && (f.getAttribute('srcdoc') || '').includes('这是一封 mock 邮件') ? f : null
  }, 15000, '阅读窗 iframe 渲染正文')
  check('读信渲染：沙盒 iframe（srcdoc），正文在 iframe 内、不直接 v-html 插主应用',
    !!frame && (frame.getAttribute('sandbox') || '').includes('allow-same-origin') && !(frame.getAttribute('sandbox') || '').includes('allow-scripts'))

  // 请求日志断言（契约）
  const has = (method, re) => mock.log.some((e) => e.method === method && re.test(e.path))
  check('请求：GET /api/auth/status', has('GET', /^\/api\/auth\/status/))
  check('请求：POST /api/auth/login（JSON 用户名+密码）', mock.log.some((e) => e.method === 'POST' && e.path === '/api/auth/login' && e.body?.username === 'tester'))
  check('请求：GET /api/accounts', has('GET', /^\/api\/accounts$/))
  check('请求：聚合视图 GET /api/messages?view=all-inbox（不带 accountId）', mock.log.some((e) => {
    if (!/^\/api\/messages\?/.test(e.path)) return false
    const u = new URL(e.path, origin)
    return u.searchParams.get('view') === 'all-inbox' && !u.searchParams.get('accountId')
  }))
  check('懒加载：初始化不预取文件夹（无 /folders 请求），点邮箱后才按需加载', !mock.log.some((e) => /\/folders/.test(e.path)))

  // 5. Socket.io：new-mail → unreadCounts 更新 → 角标 (1)->(2)，新邮件进列表
  // 注意：必须在点邮箱行之前断言——桌面端点邮箱后会自动打开第一封（即这封新邮件），
  // 打开即标已读，角标会变回 (1)，那是正确行为。
  await waitFor(() => mock.connections >= 1, 10000, 'Socket.io 连接建立')
  check('Socket.io 客户端连上 mock 服务端', mock.connections >= 1, `connections=${mock.connections}`)
  await waitFor(() => {
    const row = qa('#account-list .acct-row').find((el) => el.textContent.includes('luck534@163.com'))
    return row && row.textContent.includes('(2)')
  }, 15000, '账号角标 (1)->(2)')
  check('收到 new-mail 后左栏角标即时 (1)->(2)（Pinia unreadCounts 响应式更新）', true)
  await waitFor(() => text().includes('Socket.io 新邮件'), 10000, '新邮件进列表')
  check('收到 new-mail 后新邮件进 mailList（无需刷新）', text().includes('Socket.io 新邮件'))

  // 4. 点邮箱行 → 单邮箱视图 view=folder&accountId=2&folderId=21（收件箱文件夹）
  const acctRow = qa('#account-list .acct-row').find((el) => el.textContent.includes('luck534@163.com'))
  click(acctRow)
  await waitFor(() => mock.log.some((e) => {
    const u = new URL(e.path, origin)
    return e.method === 'GET' && u.pathname === '/api/messages' && u.searchParams.get('view') === 'folder' && u.searchParams.get('accountId') === '2' && u.searchParams.get('folderId') === '21'
  }), 10000, '单邮箱视图请求')
  check('点邮箱行：调 view=folder&accountId=2&folderId=21（只看该邮箱收件箱）', true)
  check('懒加载：点邮箱行时才调 GET /api/accounts/2/folders', has('GET', /^\/api\/accounts\/2\/folders/))

  // 5. 点“所有未读”→ 聚合视图 view=all-unread（不带 accountId）
  const unreadAgg = qa('#desktop-layout [class*="cursor-pointer"]').find((el) => el.textContent.trim().startsWith('所有未读'))
  click(unreadAgg)
  await waitFor(() => mock.log.some((e) => {
    const u = new URL(e.path, origin)
    return e.method === 'GET' && u.pathname === '/api/messages' && u.searchParams.get('view') === 'all-unread' && !u.searchParams.get('accountId')
  }), 10000, '聚合未读请求')
  check('点所有未读：调 view=all-unread（不带 accountId，全部邮箱合并）', true)

  // 7. 读信 → 删除（删后 mailList 与角标即时更新，不重新拉全量）
  // 此时在“所有未读”视图，桌面端已自动打开第一封未读（'未读测试邮件'，id 2）；删它。
  await waitFor(() => q('h1')?.textContent?.includes('未读测试邮件'), 10000, '自动打开第一封未读')
  click(q('[title="删除"]'))
  // S3：单封删除先弹确认框，点“确定”后才发 DELETE
  await waitFor(() => text().includes('确定删除这封邮件吗'), 10000, '删除确认框')
  check('单封删除先弹确认框', text().includes('确定删除这封邮件吗'))
  click(qa('button').find((b) => b.textContent.trim() === '确定'))
  await waitFor(() => mock.log.some((e) => e.method === 'DELETE' && /^\/api\/messages\/\d+/.test(e.path)), 10000, 'DELETE 请求')
  const delEntry = mock.log.find((e) => e.method === 'DELETE')
  check('删除调 DELETE /api/messages/:id', !!delEntry, delEntry?.path || '')
  await sleep(500)
  check('删信后列表为空态（本地 mailList 即时更新，未重新拉全量）', text().includes('这里没有邮件'))

  // 7b. 删除失败路径（F1/F13）：服务端 500 时行必须仍在、toast 为失败，
  // 而不是列表被清空或误报成功。先回所有收件箱（自动打开第一封 Socket.io 新邮件），
  // 再打开 mock 的删除失败开关删它。
  const inboxAgg = qa('#desktop-layout [class*="cursor-pointer"]').find((el) => el.textContent.trim().startsWith('所有收件箱'))
  click(inboxAgg)
  await waitFor(() => q('h1')?.textContent?.includes('Socket.io 新邮件'), 10000, '回到收件箱并自动打开第一封')
  mock.setDeleteFail(true)
  click(q('[title="删除"]'))
  await waitFor(() => text().includes('确定删除这封邮件吗'), 10000, '删除确认框（失败路径）')
  click(qa('button').find((b) => b.textContent.trim() === '确定'))
  await waitFor(() => text().includes('删除失败'), 10000, '删除失败 toast')
  check('删除失败时 toast 为“删除失败，请重试”（后端原话透传）', text().includes('删除失败，请重试'))
  check('删除失败时行仍在列表（服务端未删成，对账后不闪空）', text().includes('Socket.io 新邮件'))
  mock.setDeleteFail(false)

  // 8. 写信发送
  click(q('#btn-compose'))
  await waitFor(() => q('#compose-to, input[placeholder*="收件人"]'), 10000, '写信弹窗')
  const toInput = document.querySelector('#compose-to') || q('input[placeholder*="收件人"]')
  setInput(toInput, 'a@example.com')
  setInput(q('#compose-subject') || document.querySelector('input[placeholder="主题（必填）"]'), '冒烟测试')
  setInput(q('#compose-body') || document.querySelector('textarea[placeholder*="正文"]'), 'hello')
  const sendBtn = qa('button').find((b) => b.textContent.trim() === '发送')
  click(sendBtn)
  await waitFor(() => mock.log.some((e) => e.method === 'POST' && e.path === '/api/messages/send'), 10000, '发信请求')
  const sendEntry = mock.log.find((e) => e.method === 'POST' && e.path === '/api/messages/send')
  check('写信发送调 POST /api/messages/send', !!sendEntry, JSON.stringify(sendEntry?.body || sendEntry?.raw || ''))
  check('发信带 idempotencyKey（UUID，同一封重试复用）', typeof sendEntry?.body?.idempotencyKey === 'string' && sendEntry.body.idempotencyKey.length > 0, String(sendEntry?.body?.idempotencyKey || ''))
  // F2：发信成功 toast 为“发送成功”（4 秒），随后切到所有已发送，
  // 并用 201 返回的 id 直接打开刚发的信（mock 里 id 100）。
  await waitFor(() => text().includes('发送成功'), 10000, '发送成功 toast')
  check('发信成功提示“发送成功”', text().includes('发送成功'))
  await waitFor(() => q('h1')?.textContent?.includes('冒烟测试'), 10000, '切到已发送并打开刚发的信')
  check('发信后切到所有已发送、首封（刚发的信）自动打开', !!q('h1')?.textContent?.includes('冒烟测试'))

  // 9. 移动端 QQ 布局 DOM
  check('移动端 QQ 布局：账号总览（常用文件夹/我的邮箱）在 DOM', text().includes('常用文件夹') && text().includes('我的邮箱'))
  check('移动端 QQ 布局：侧滑文件夹抽屉在 DOM', !!q('.m-drawer'))
  check('移动端 QQ 布局：页签（未读邮件/管理）在 DOM', text().includes('未读邮件') && text().includes('管理'))

  await mock.close()
  dom.window.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) { console.log('失败项：', failed.map((f) => f.name).join('；')); process.exit(1) }
  process.exit(0)
}

main().catch((e) => { console.error('SMOKE 异常：', e); process.exit(1) })
