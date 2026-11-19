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
  // 不自动打开（2026-11-18 定夺：全部手动点开）——冒烟里凡是原来靠自动打开
  // 进阅读窗的步骤，改成先按主题点列表行再断言；等行出现再点，避免
  // 列表还没拉回来时按旧正文误判（比如阅读窗里还留着上一封的标题）。
  const clickRowBySubject = async (subject) => {
    const row = await waitFor(() => qa('#desktop-layout .group.relative.cursor-pointer').find((el) => el.textContent.includes(subject)) || null, 10000, `列表出现主题为 ${subject} 的行`)
    click(row)
  }

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
  check('不自动打开：列表加载后阅读窗为空状态', text().includes('在此查看列表中选中的邮件'))
  // 不自动打开（2026-11-18 定夺：全部手动点开）——点第一封才进阅读窗
  await clickRowBySubject('欢迎使用 Luck-Mail')
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
  // 注意：不自动打开（2026-11-18 定夺）——点邮箱行只切视图不出信，新邮件
  // 保持未读、角标一直是 (2)，直到用户自己点开它才标已读。
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

  // 审计 #11 H2：在“所有未读”里搜索，搜索结果数不能改写未读角标。
  // 此时未读 2 封（未读测试邮件 + Socket.io 新邮件）；搜 'Socket.io' 只命中 1 封，
  // 左栏“所有未读”角标须仍是 (2)，不能变成 (1)。
  const searchInput = q('#desktop-layout input[placeholder="搜索邮件..."]')
  setInput(searchInput, 'Socket.io')
  await waitFor(() => text().includes('Socket.io 新邮件') && !text().includes('未读测试邮件'), 10000, '搜索结果只剩 Socket.io 新邮件')
  await sleep(300)
  const unreadAggRow = qa('#desktop-layout [class*="cursor-pointer"]').find((el) => el.textContent.trim().startsWith('所有未读'))
  check('H2：所有未读里搜索后角标仍是真实未读数 (2)，不是搜索结果数 (1)', !!unreadAggRow && unreadAggRow.textContent.includes('(2)'), unreadAggRow?.textContent || '')
  // 审计 #11 L9：桌面与移动两实例搜索框值一致，且防抖搜索只发一次请求。
  const searchInputs = qa('input[placeholder="搜索邮件..."]')
  check('L9：桌面与移动两实例搜索框值一致', searchInputs.length === 2 && searchInputs.every((el) => el.value === 'Socket.io'), searchInputs.map((el) => el.value).join('|'))
  const socketSearchReqs = mock.log.filter((e) => { const u = new URL(e.path, origin); return e.method === 'GET' && u.pathname === '/api/messages' && u.searchParams.get('q') === 'Socket.io' })
  check('L9：防抖搜索只发一次请求（两实例不重复发）', socketSearchReqs.length === 1, `q=Socket.io 请求数=${socketSearchReqs.length}`)
  // 清掉搜索，回到未读列表（后面步骤假定未读视图里有两封）。
  setInput(searchInput, '')
  await waitFor(() => text().includes('未读测试邮件'), 10000, '清搜索后未读列表恢复')

  // 6a. 草稿视图合并 IMAP 草稿（2026-11-19 修复）：以前只读服务端草稿，
  // 邮箱同步来的草稿在界面上完全看不见。点“所有草稿”，应调
  // view=all-drafts 取 IMAP 草稿，列表里出现 mock 的 IMAP 草稿。
  const draftsAgg = qa('#desktop-layout [class*="cursor-pointer"]').find((el) => el.textContent.trim().startsWith('所有草稿'))
  click(draftsAgg)
  await waitFor(() => text().includes('IMAP 草稿测试'), 10000, '草稿视图出现 IMAP 草稿')
  check('草稿视图：IMAP 同步来的草稿出现在列表里（与服务端草稿合并）', text().includes('IMAP 草稿测试'))
  check('草稿视图：调 GET /api/messages?view=all-drafts 取 IMAP 草稿', mock.log.some((e) => {
    const u = new URL(e.path, origin)
    return e.method === 'GET' && u.pathname === '/api/messages' && u.searchParams.get('view') === 'all-drafts'
  }))

  // 审计 #11 B1：服务端草稿 id 4 与 IMAP 草稿消息 id 4 撞号——两者须同时在列，
  // 各自点开正确（服务端草稿开写信弹窗，IMAP 草稿进阅读窗）。
  check('B1 撞号：服务端草稿(id 4)与 IMAP 草稿(id 4)同时在草稿视图里', text().includes('服务端草稿撞号测试') && text().includes('IMAP 草稿测试'))
  await clickRowBySubject('IMAP 草稿测试')
  await waitFor(() => q('h1')?.textContent?.includes('IMAP 草稿测试'), 10000, 'IMAP 草稿进阅读窗')
  check('B1 撞号：点 IMAP 草稿进阅读窗（不是错开成编辑草稿）', !!q('h1')?.textContent?.includes('IMAP 草稿测试'))
  await clickRowBySubject('服务端草稿撞号测试')
  await waitFor(() => q('input[placeholder="主题（必填）"]')?.value === '服务端草稿撞号测试', 10000, '服务端草稿开写信弹窗')
  check('B1 撞号：点服务端草稿开写信弹窗（主题回填正确）', q('input[placeholder="主题（必填）"]')?.value === '服务端草稿撞号测试')
  // 关掉写信弹窗，回到草稿视图继续（后面步骤假定不在弹窗里）。
  click(qa('button').find((b) => b.textContent.trim() === '取消'))
  await sleep(300)

  // 审计 #11 L14：草稿视图里搜索，服务端草稿（不进 FTS）须本地过滤拼入结果；
  // IMAP 草稿不含“撞号”，只剩服务端草稿。等 IMAP 行消失再断言（搜前两行都在，
  // 只等服务端草稿出现是空条件）。
  const draftSearchInput = q('#desktop-layout input[placeholder="搜索邮件..."]')
  setInput(draftSearchInput, '撞号')
  await waitFor(() => text().includes('服务端草稿撞号测试') && !text().includes('IMAP 草稿测试'), 10000, '草稿搜索后只剩服务端草稿')
  check('L14：草稿视图里搜索，服务端草稿本地过滤拼入结果', text().includes('服务端草稿撞号测试') && !text().includes('IMAP 草稿测试'))
  setInput(draftSearchInput, '')
  await waitFor(() => text().includes('IMAP 草稿测试'), 10000, '清搜索后草稿列表恢复')

  // 审计 #15 LOW-1：草稿视图搜索命中 >50 行服务端草稿时，第 2 页起的行
  // 不能丢——旧版只在第 1 页拼入并截断，被顶出的行在第 2 页（offset 50）
  // 也取不到、永久不显示，且总数虚高。
  setInput(draftSearchInput, '旧草稿填充测试')
  await waitFor(() => text().includes('1/2 页 · 55 封'), 10000, '草稿搜索命中 55 封服务端草稿（2 页）')
  check('审计 #15 LOW-1：草稿搜索命中 55 封时总数按真实数算（55 封、2 页）', text().includes('1/2 页 · 55 封'))
  click(qa('#desktop-layout button').find((b) => b.textContent.trim().startsWith('下一页')))
  await waitFor(() => text().includes('旧草稿填充测试 055'), 10000, '草稿搜索第 2 页出现最旧的填充草稿')
  check('审计 #15 LOW-1：草稿搜索第 2 页能看到被顶出第 1 页的旧草稿（不再丢行）', text().includes('旧草稿填充测试 055'))
  // 审计 #16 LOW-1：草稿搜索多词 AND + 正文全文——“发票”在主题、
  // “2026”在正文 80 字之后；旧版整句 includes + 只看 snippet 前 80 字搜不到它。
  setInput(draftSearchInput, '发票 2026')
  await waitFor(() => text().includes('发票申请') && text().includes('1/1 页 · 1 封'), 10000, '草稿多词搜索命中发票申请草稿')
  check('LOW-1：草稿搜索多词分词 AND、正文全文匹配（发票在主题、2026 在正文 80 字后）', text().includes('发票申请') && text().includes('1/1 页 · 1 封'))
  setInput(draftSearchInput, '')
  await waitFor(() => text().includes('IMAP 草稿测试'), 10000, '清搜索后草稿列表恢复')

  // 7a. 文件夹角标对账：此时 luck534 的账号与收件夹角标都是 (2)（1 封旧未读 +
  // Socket.io 新邮件）。切到“所有已发送”，模拟服务端那边的未读数已降为 1
  //（比如别处删了一封未读信，前端没看到过程），再由服务端推一条 mail-deleted
  //（事件只有 messageId、行也不在当前列表里，本地没法直接扣减）；
  // 前端必须防抖重载 /folders 对账，文件夹角标 (2)->(1)、账号角标随文件夹
  // 之和一起 (2)->(1)。旧逻辑（max 只升不降、无重载触发）会永远停在 (2)。
  const sentAgg = qa('#desktop-layout [class*="cursor-pointer"]').find((el) => el.textContent.trim().startsWith('所有已发送'))
  click(sentAgg)
  await waitFor(() => mock.log.some((e) => {
    const u = new URL(e.path, origin)
    return e.method === 'GET' && u.pathname === '/api/messages' && u.searchParams.get('view') === 'all-sent'
  }), 10000, '切到所有已发送')
  mock.setFolderUnread(2, 21, 1)
  mock.emitMailDeleted({ messageId: 999 })
  await waitFor(() => {
    const row = qa('#account-list .acct-row').find((el) => el.textContent.includes('luck534@163.com'))
    return row && row.textContent.includes('(1)')
  }, 10000, '删信对账后账号角标 (2)->(1)')
  const folderBox = qa('#account-list .acct-folders')[1]
  check('删信对账：mail-deleted（行不在列表）触发文件夹重载，账号角标 (2)->(1)', true)
  check('删信对账：文件夹收件夹角标 (2)->(1)', !!folderBox && folderBox.textContent.includes('收件箱') && folderBox.textContent.includes('(1)'), folderBox?.textContent || '')
  check('删信对账：重载了 GET /api/accounts/2/folders（防抖合并，展开时 1 次 + 对账 1 次）', mock.log.filter((e) => e.method === 'GET' && /^\/api\/accounts\/2\/folders/.test(e.path)).length >= 2, `folders 请求数=${mock.log.filter((e) => e.method === 'GET' && /^\/api\/accounts\/2\/folders/.test(e.path)).length}`)
  // 审计 #16 MED-1：已发送去重须有测试覆盖——同收件人双行合并、不同收件人
  // 两行都显示、缺 to 的旧行正常显示（不被去重吞掉）。此时已发送共 6 行
  //（旧种子 1 + 双行种子 5），合并 1 行后显示 5 行、总数 5 封。
  const countSentRows = (subject) => qa('#desktop-layout .group.relative.cursor-pointer').filter((el) => el.textContent.includes(subject)).length
  await waitFor(() => text().includes('去重测试同收件人'), 10000, '已发送出现去重种子行')
  check('MED-1：同收件人双行合并只显示一行', countSentRows('去重测试同收件人') === 1, `行数=${countSentRows('去重测试同收件人')}`)
  check('MED-1：同收件人合并后总数扣 1（6 行 → 5 封）', text().includes('1/1 页 · 5 封'))
  check('MED-1：不同收件人两行都显示', countSentRows('去重测试不同收件人') === 2, `行数=${countSentRows('去重测试不同收件人')}`)
  check('MED-1：缺 to 的旧行正常显示、不被去重吞掉', countSentRows('缺收件人旧行') === 1, `行数=${countSentRows('缺收件人旧行')}`)
  // 回到“所有未读”，继续原有的删除流程（下面第 7 步假定在这个视图）。
  click(unreadAgg)
  await waitFor(() => text().includes('未读测试邮件'), 10000, '回到所有未读')

  // 7. 读信 → 删除（删后 mailList 与角标即时更新，不重新拉全量）
  // 此时在“所有未读”视图（两封未读：Socket.io 新邮件 + 未读测试邮件），
  // 手动点开“未读测试邮件”（id 2）再删它。
  await clickRowBySubject('未读测试邮件')
  await waitFor(() => q('h1')?.textContent?.includes('未读测试邮件'), 10000, '手动打开第一封未读')
  // 审计 #11 M7：在“所有未读”里打开后标已读，该行应立即离开未读列表
  //（阅读窗里的信不受影响，仍在读）。
  await waitFor(() => qa('#desktop-layout .group.relative.cursor-pointer').filter((el) => el.textContent.includes('未读测试邮件')).length === 0, 10000, 'M7 已读信离开未读列表')
  check('M7：所有未读里打开标已读后，已读信离开列表（阅读窗仍在读）', !!q('h1')?.textContent?.includes('未读测试邮件'))
  // 审计 #13 MED-1：mail-updated 回声导致角标多减 1——“所有未读”里打开
  // “未读测试邮件”标已读后，行已离开列表（HTTP 响应先到）；随后后端
  // 回声（mail-updated，isRead=true）到达时，!row 分支若再 bump −1，
  // 角标会从 (1) 掉到 (0)。此时未读只剩 Socket.io 新邮件 1 封。
  mock.emitMailUpdated({ messageId: 2, accountId: 2, folderId: 21, changes: { isRead: true } })
  await sleep(500)
  const unreadAggRow2 = qa('#desktop-layout [class*="cursor-pointer"]').find((el) => el.textContent.trim().startsWith('所有未读'))
  check('MED-1：标已读回声到达后角标仍是 (1)，不被多减成 (0)', !!unreadAggRow2 && unreadAggRow2.textContent.includes('(1)'), unreadAggRow2?.textContent || '')
  click(q('[title="删除"]'))
  // S3：单封删除先弹确认框，点“确定”后才发 DELETE
  await waitFor(() => text().includes('确定删除这封邮件吗'), 10000, '删除确认框')
  check('单封删除先弹确认框', text().includes('确定删除这封邮件吗'))
  click(qa('button').find((b) => b.textContent.trim() === '确定'))
  await waitFor(() => mock.log.some((e) => e.method === 'DELETE' && /^\/api\/messages\/\d+/.test(e.path)), 10000, 'DELETE 请求')
  const delEntry = mock.log.find((e) => e.method === 'DELETE')
  check('删除调 DELETE /api/messages/:id', !!delEntry, delEntry?.path || '')
  // 审计 #6：单封删除请求体带 idempotencyKey（删信幂等前端接线），响应丢失
  // 后重试同一删除时后端认得出是同一动作，不会把“移到已删除”变成永久删除。
  check('单封删除请求带 idempotencyKey', typeof delEntry?.body?.idempotencyKey === 'string' && delEntry.body.idempotencyKey.length > 0, String(delEntry?.body?.idempotencyKey || ''))
  await sleep(500)
  // 删掉 id 2 后未读列表里还剩 Socket.io 新邮件（id 99）；2026-11-18 定夺
  // “全部手动点开”：删信后不再自动打开下一封，阅读窗回到空状态。
  check('删信后列表即时更新（删掉的行没了，未删的还在，未重新拉全量）', !text().includes('未读测试邮件') && text().includes('Socket.io 新邮件'))
  check('删信后阅读窗回到空状态（不再自动打开下一封）', text().includes('在此查看列表中选中的邮件。'))

  // 7b. 删除失败路径（F1/F13）：服务端 500 时行必须仍在、toast 为失败，
  // 而不是列表被清空或误报成功。先回所有收件箱，手动点开 Socket.io 新邮件，
  // 再打开 mock 的删除失败开关删它。
  const inboxAgg = qa('#desktop-layout [class*="cursor-pointer"]').find((el) => el.textContent.trim().startsWith('所有收件箱'))
  click(inboxAgg)
  await clickRowBySubject('Socket.io 新邮件')
  await waitFor(() => q('h1')?.textContent?.includes('Socket.io 新邮件'), 10000, '手动打开 Socket.io 新邮件')
  mock.setDeleteFail(true)
  click(q('[title="删除"]'))
  await waitFor(() => text().includes('确定删除这封邮件吗'), 10000, '删除确认框（失败路径）')
  click(qa('button').find((b) => b.textContent.trim() === '确定'))
  await waitFor(() => text().includes('删除失败'), 10000, '删除失败 toast')
  check('删除失败时 toast 为“删除失败，请重试”（可读业务错误原文保留）', text().includes('删除失败，请重试'))
  check('删除失败时行仍在列表（服务端未删成，对账后不闪空）', text().includes('Socket.io 新邮件'))
  // 审计 #19 LOW-1：后端错误原文含 SQLite 内部错误（UNIQUE constraint）
  // 时，前端须映射成友好文案，不能把表结构透传给用户。先记下已有 DELETE
  // 次数，再删一次，等新请求发出后再断言 toast（旧 toast 仍在时直接断言
  // 会空过）。
  const delCountBefore = mock.log.filter((e) => e.method === 'DELETE' && /^\/api\/messages\/\d+$/.test(e.path)).length
  mock.setDeleteFail(true, 'IMAP 删除失败：UNIQUE constraint failed: messages.account_id, messages.folder_id, messages.message_id')
  click(q('[title="删除"]'))
  await waitFor(() => text().includes('确定删除这封邮件吗'), 10000, '删除确认框（内部错误映射）')
  click(qa('button').find((b) => b.textContent.trim() === '确定'))
  await waitFor(() => mock.log.filter((e) => e.method === 'DELETE' && /^\/api\/messages\/\d+$/.test(e.path)).length > delCountBefore, 10000, '第二次 DELETE 请求（内部错误）')
  await sleep(500)
  check('LOW-1：后端报 UNIQUE constraint 时 toast 为“删除失败，请重试”，不透传内部错误', text().includes('删除失败，请重试') && !text().includes('UNIQUE') && !text().includes('constraint'), text().match(/删除失败[^\n]*/)?.[0] || '')
  check('LOW-1：内部错误导致删除失败时行仍在列表', text().includes('Socket.io 新邮件'))
  mock.setDeleteFail(false)

  // 审计 #11 H1：回复 threading——草稿 POST 里应带 inReplyTo/references；
  // 点发送后 send 载荷里也应带 inReplyTo/references（重开草稿再发仍是同一会话）。
  // 审计 #14 BLOCKER：回复后不改任何字直接点“存草稿”——以前 autosaveDraft
  // 的 sameSnapshot 守卫会跳过保存、一次 POST 都不发，saveDraft 照样关窗
  // 切视图，回复草稿静默丢失。现在 saveDraft 强制保存，草稿须落盘、出现
  // 在草稿视图。断言以草稿视图为准：旧代码下不改字永远存不上。
  // 此时阅读窗里是 Socket.io 新邮件（id 99，mock 详情返回 replyTo）。
  click(q('[title="回复"]'))
  await waitFor(() => q('input[placeholder="主题（必填）"]'), 10000, '回复写信弹窗')
  const replyToInput = q('#compose-to') || q('input[placeholder*="收件人"]')
  check('H1/L23：回复收件人默认 Reply-To（mock 详情返回 reply-to@example.com）', replyToInput?.value === 'reply-to@example.com', replyToInput?.value || '')
  check('H1/M5：回复主题只加一次前缀（原主题无前缀）', (q('input[placeholder="主题（必填）"]')?.value || '') === '回复：Socket.io 新邮件', q('input[placeholder="主题（必填）"]')?.value || '')
  // 不改任何字直接点“存草稿”（须在输入防抖自动保存 1 秒触发前点下去，
  // 否则断言会被自动保存的 POST 掩盖；但无论哪条路径先跑，新代码都会落盘）。
  click(qa('button').find((b) => b.textContent.trim() === '存草稿'))
  await waitFor(() => mock.log.some((e) => e.method === 'POST' && e.path === '/api/drafts' && e.body?.inReplyTo), 10000, '不改字存草稿 POST')
  const draftEntry = [...mock.log].reverse().find((e) => e.method === 'POST' && e.path === '/api/drafts')
  check('审计 #14 BLOCKER：回复后不改字点“存草稿”，草稿已落盘（POST /api/drafts）', !!draftEntry, JSON.stringify(draftEntry?.body || ''))
  check('H1：草稿保存带 inReplyTo（重开草稿再发仍是同一会话）', typeof draftEntry?.body?.inReplyTo === 'string' && draftEntry.body.inReplyTo.length > 0, JSON.stringify(draftEntry?.body || ''))
  check('H1：草稿保存带 references', typeof draftEntry?.body?.references === 'string' && draftEntry.body.references.includes('mock-99@local'), JSON.stringify(draftEntry?.body || ''))
  await waitFor(() => text().includes('回复：Socket.io 新邮件') && !q('input[placeholder="主题（必填）"]'), 10000, '存草稿后切到草稿视图')
  check('审计 #14 BLOCKER：回复后不改字点“存草稿”，草稿视图出现该回复草稿', text().includes('回复：Socket.io 新邮件'))
  check('审计 #14 BLOCKER：存草稿成功后写信窗已关闭', !q('input[placeholder="主题（必填）"]'))
  // 审计 #12 B1/M4：重开回复草稿——点开这封回复草稿，写信窗须重新打开且
  // threading 回填。以前 mock 回字符串、真实后端回数组，MailView 在数组上
  // 调 .split 直接崩，只弹“页面出现异常”。
  await clickRowBySubject('回复：Socket.io 新邮件')
  await waitFor(() => q('input[placeholder="主题（必填）"]')?.value === '回复：Socket.io 新邮件', 10000, '重开回复草稿打开写信弹窗')
  check('B1：重开回复草稿能打开写信弹窗（不再报“页面出现异常”）', q('input[placeholder="主题（必填）"]')?.value === '回复：Socket.io 新邮件', q('input[placeholder="主题（必填）"]')?.value || '')
  check('B1：重开回复草稿时无“页面出现异常”toast', !text().includes('页面出现异常'))
  // 在重开的写信窗里改一下正文触发自动保存（PUT），载荷里须仍带 threading——
  // 证明回填进弹窗的 inReplyTo/references 没有丢。
  setInput(q('#compose-body') || document.querySelector('textarea[placeholder*="正文"]'), 'hello reply again')
  await waitFor(() => mock.log.some((e) => e.method === 'PUT' && e.path.startsWith('/api/drafts/') && e.body?.inReplyTo), 10000, '重开草稿自动保存（PUT）')
  const reopenPut = [...mock.log].reverse().find((e) => e.method === 'PUT' && e.path.startsWith('/api/drafts/'))
  check('B1：重开回复草稿再编辑，自动保存仍带 inReplyTo', reopenPut?.body?.inReplyTo === '<mock-99@local>', JSON.stringify(reopenPut?.body || ''))
  check('B1：重开回复草稿再编辑，自动保存仍带 references（含原信 Message-ID）', typeof reopenPut?.body?.references === 'string' && reopenPut.body.references.includes('mock-99@local'), JSON.stringify(reopenPut?.body || ''))
  click(qa('button').find((b) => b.textContent.trim() === '发送'))
  await waitFor(() => mock.log.some((e) => e.method === 'POST' && e.path === '/api/messages/send' && e.body?.inReplyTo), 10000, '回复发信请求')
  const replySendEntry = [...mock.log].reverse().find((e) => e.method === 'POST' && e.path === '/api/messages/send')
  check('H1：回复发信带 inReplyTo', replySendEntry?.body?.inReplyTo === '<mock-99@local>', JSON.stringify(replySendEntry?.body || ''))
  check('H1：回复发信带 references（含原信 Message-ID）', Array.isArray(replySendEntry?.body?.references) && replySendEntry.body.references.includes('<mock-99@local>'), JSON.stringify(replySendEntry?.body || ''))
  await waitFor(() => text().includes('发送成功'), 10000, '回复发送成功 toast')

  // 审计 #13 MED-2：服务端草稿超 50 封后，第 51 封起在界面上打不开。
  // mock 预置 55 封旧草稿 + 撞号草稿 1 封 + 发票申请草稿 1 封（审计 #16
  // LOW-1 种子）= 57 封服务端草稿（B1 回复草稿已发出被删），加 IMAP
  // 草稿 1 封，草稿视图共 58 封、2 页。
  const draftsAgg3 = qa('#desktop-layout [class*="cursor-pointer"]').find((el) => el.textContent.trim().startsWith('所有草稿'))
  click(draftsAgg3)
  await waitFor(() => text().includes('1/2 页 · 58 封'), 10000, '草稿视图第 1 页（58 封、2 页）')
  check('MED-2：草稿超 50 封后总数按真实数算（58 封、2 页）', text().includes('1/2 页 · 58 封'))
  check('MED-2：loadDrafts 用 limit=200 拉草稿', mock.log.some((e) => {
    const u = new URL(e.path, origin)
    return e.method === 'GET' && u.pathname === '/api/drafts' && u.searchParams.get('limit') === '200'
  }))
  // 翻到第 2 页，最旧的填充草稿（055）应出现——旧版只拉前 50 封服务端草稿，
  // 第 2 页只有 IMAP 草稿，永远看不到它。
  click(qa('#desktop-layout button').find((b) => b.textContent.trim().startsWith('下一页')))
  await waitFor(() => text().includes('旧草稿填充测试 055'), 10000, '草稿视图第 2 页出现最旧的填充草稿')
  check('MED-2：第 51 封起的旧草稿在第 2 页可见', text().includes('旧草稿填充测试 055'))

  // 审计 #20 LOW-1：异步批量删除结算须计服务端草稿失败，且已删草稿行
  // 应立即离开列表——以前 pendingBatchDelete 只带删成功的草稿数，
  // failedDraftCount 被丢掉，结算 toast 只报邮件失败；异步分支也只拿掉
  // serverIds，已删草稿行要等轮询结束重拉才消失。
  // 勾选组合：IMAP 草稿 1 封（走服务端批量删除、强制异步 taskId 路径）
  // + 服务端填充草稿 001（删成功）+ 002（mock 开关令其 DELETE 500）。
  // 结算：deleted=1（IMAP 草稿）+ draftCount=1（001）= 2 封，
  // failed=0 + failedDraftCount=1（002）= 1 封 → toast“已删除 2 封，1 封失败”。
  click(qa('#desktop-layout button').find((b) => b.textContent.includes('上一页')))
  await waitFor(() => text().includes('IMAP 草稿测试'), 10000, '回草稿第 1 页（#20 批量删除）')
  mock.setDraftDeleteFailIds([1002])
  mock.setDeleteStatusResult({ total: 1, deleted: 1, failed: [] })
  const checkDraftRow = (subject) => {
    const row = qa('#desktop-layout .group.relative.cursor-pointer').find((el) => el.textContent.includes(subject))
    const cb = row.querySelector('input[title="选择这封邮件"]')
    cb.checked = true
    cb.dispatchEvent(new window.Event('change', { bubbles: true }))
  }
  checkDraftRow('IMAP 草稿测试')
  checkDraftRow('旧草稿填充测试 001')
  checkDraftRow('旧草稿填充测试 002')
  await waitFor(() => text().includes('已选 3 封'), 10000, '勾选 3 封待批量删除（#20）')
  click(qa('#desktop-layout button').find((b) => b.textContent.trim() === '删除'))
  await waitFor(() => text().includes('确定移到已删除选中的 3 封邮件吗？'), 10000, '批量删除确认框（#20）')
  click(qa('button').find((b) => b.textContent.trim() === '确定'))
  await waitFor(() => mock.log.some((e) => e.method === 'POST' && e.path === '/api/messages/batch-delete'), 10000, '批量删除请求（#20）')
  await sleep(300)
  check('LOW-1：异步分支里已删的服务端草稿行立即离开列表（不等轮询）', qa('#desktop-layout .group.relative.cursor-pointer').filter((el) => el.textContent.includes('旧草稿填充测试 001')).length === 0)
  check('LOW-1：删失败的服务端草稿行留在列表里', qa('#desktop-layout .group.relative.cursor-pointer').filter((el) => el.textContent.includes('旧草稿填充测试 002')).length === 1)
  await waitFor(() => text().includes('已删除 2 封，1 封失败'), 15000, '批量删除结算 toast（含草稿失败数）')
  check('LOW-1：异步批量删除结算 toast 计入草稿失败数', text().includes('已删除 2 封，1 封失败'))
  mock.setDraftDeleteFailIds([])
  mock.setDeleteStatusResult(null)

  // 审计 #17 LOW-1：草稿视图里把 IMAP 草稿移垃圾——以前 rowBelongsToView
  // 缺 all-drafts 分支、落到末尾 return true，行滞留列表直到下次加载；
  // 现在移走后行应立即离开列表、总数 57→56（#20 测试已先删掉 1 封填充草稿）。
  // IMAP 草稿日期最新、排第 1 页首位（与服务端草稿合并后按日期排），须先回第 1 页再点它。
  click(qa('#desktop-layout button').find((b) => b.textContent.includes('上一页')))
  await waitFor(() => text().includes('IMAP 草稿测试'), 10000, '回草稿第 1 页')
  await clickRowBySubject('IMAP 草稿测试')
  await waitFor(() => q('h1')?.textContent?.includes('IMAP 草稿测试'), 10000, 'IMAP 草稿进阅读窗')
  click(q('#desktop-layout button[title="标记为垃圾邮件"]'))
  await waitFor(() => qa('#desktop-layout .group.relative.cursor-pointer').filter((el) => el.textContent.includes('IMAP 草稿测试')).length === 0, 10000, '移垃圾后草稿行离开列表')
  check('LOW-1：草稿视图里移垃圾，行立即离开列表（不滞留到下次加载）', qa('#desktop-layout .group.relative.cursor-pointer').filter((el) => el.textContent.includes('IMAP 草稿测试')).length === 0)
  check('LOW-1：移垃圾后草稿总数 57→56', text().includes('1/2 页 · 56 封'), text().match(/\d\/\d 页 · \d+ 封/)?.[0] || '')

  // 审计 #18 MED-1：删信时正好有一次列表重载在跑，过期响应到达后已删的
  // 行不应复活——deleteMessage 须作废挂起的加载（只加 loadSeq、不 abort）。
  // mock 把一次 GET /api/messages 挂起（快照里还含着要删的信），期间删信，
  // 再放行响应；旧代码下放行后整页列表被旧快照整体替换、已删的行回来。
  // 此时所有收件箱剩 2 封（欢迎使用 Luck-Mail + Socket.io 新邮件；未读
  // 测试邮件已在第 7 步删掉），删掉前者后应剩 1 封。
  const inboxAgg2 = qa('#desktop-layout [class*="cursor-pointer"]').find((el) => el.textContent.trim().startsWith('所有收件箱'))
  click(inboxAgg2)
  await waitFor(() => text().includes('欢迎使用 Luck-Mail'), 10000, '回所有收件箱')
  const msgReqsBefore = mock.log.filter((e) => e.method === 'GET' && e.path.startsWith('/api/messages?')).length
  mock.setHoldMessages(true)
  click(q('#btn-refresh-all'))
  await waitFor(() => mock.log.filter((e) => e.method === 'GET' && e.path.startsWith('/api/messages?')).length > msgReqsBefore, 10000, '全部刷新发出列表请求（被挂起）')
  await clickRowBySubject('欢迎使用 Luck-Mail')
  await waitFor(() => q('h1')?.textContent?.includes('欢迎使用 Luck-Mail'), 10000, '点开待删邮件')
  click(q('[title="删除"]'))
  await waitFor(() => text().includes('确定删除这封邮件吗'), 10000, '删除确认框（过期响应回归）')
  click(qa('button').find((b) => b.textContent.trim() === '确定'))
  await waitFor(() => mock.log.some((e) => e.method === 'DELETE' && /^\/api\/messages\/1$/.test(e.path)), 10000, 'DELETE /api/messages/1')
  await waitFor(() => !text().includes('欢迎使用 Luck-Mail'), 10000, '删信后行离开列表')
  mock.releaseHeldMessages()
  await sleep(500)
  check('MED-1：过期列表响应到达后，已删的行不复活', !text().includes('欢迎使用 Luck-Mail'))
  check('MED-1：放行过期响应后未删的行还在（Socket.io 新邮件）', text().includes('Socket.io 新邮件'))
  check('MED-1：放行过期响应后总数仍是删后数（1 封），不被旧快照顶回', text().includes('1/1 页 · 1 封'), text().match(/\d\/\d 页 · \d+ 封/)?.[0] || '')
  check('MED-1：作废挂起加载后“加载中”不一直转', !text().includes('加载中…'))
  mock.setHoldMessages(false)

  // 审计 #19 MED-1：批量删除结算须读 delete-status 的 failed 字段——
  // 以前只看 deleted，全军覆没也会报成“已移到已删除 0 封”。mock 的
  // batch-delete 走异步返回 taskId，delete-status 回 deleted:0 +
  // failed:1 封；结算 toast 应报“删除失败，请重试”，不能报“已移到已删除 0 封”。
  // 此时所有收件箱剩 1 封（Socket.io 新邮件），勾选它走批量删除。
  mock.setDeleteStatusResult({ total: 1, deleted: 0, failed: [{ id: 99, error: 'IMAP 删除失败：移动后无法确认新位置（目标文件夹里找不到这封邮件），本地未更新' }] })
  const batchRow = qa('#desktop-layout .group.relative.cursor-pointer').find((el) => el.textContent.includes('Socket.io 新邮件'))
  const batchCb = batchRow.querySelector('input[title="选择这封邮件"]')
  batchCb.checked = true
  batchCb.dispatchEvent(new window.Event('change', { bubbles: true }))
  await waitFor(() => text().includes('已选 1 封'), 10000, '勾选 1 封待批量删除')
  click(qa('#desktop-layout button').find((b) => b.textContent.trim() === '删除'))
  await waitFor(() => text().includes('确定移到已删除选中的 1 封邮件吗？'), 10000, '批量删除确认框')
  click(qa('button').find((b) => b.textContent.trim() === '确定'))
  await waitFor(() => mock.log.some((e) => e.method === 'POST' && e.path === '/api/messages/batch-delete'), 10000, '批量删除请求')
  await waitFor(() => text().includes('删除失败'), 15000, '批量删除结算 toast（全军覆没）')
  check('MED-1：批量删除全军覆没时结算报“删除失败，请重试”', text().includes('删除失败，请重试'))
  check('MED-1：批量删除全军覆没时不报“已移到已删除 0 封”', !text().includes('已移到已删除 0 封'))
  check('MED-1：批量删除失败的行回到列表（轮询对账）', text().includes('Socket.io 新邮件'))
  mock.setDeleteStatusResult(null)

  // 发信收件人格式校验（用户 2026-11-19 要求：收件人必填、格式不正确不得
  // 发送；抄送同样校验）。打开写信窗后逐项验证：空收件人 / 非法收件人 /
  // 多收件人其一非法 / 非法抄送都应不发请求且有提示；全角逗号分隔的合法
  // 多收件人应正常进入发送流程。
  const sendCount = () => mock.log.filter((e) => e.method === 'POST' && e.path === '/api/messages/send').length
  click(q('#btn-compose'))
  await waitFor(() => q('#compose-to, input[placeholder*="收件人"]'), 10000, '写信弹窗（格式校验）')
  const fmtTo = document.querySelector('#compose-to') || q('input[placeholder*="收件人"]')
  const fmtCc = q('input[placeholder="抄送（选填）"]')
  const fmtSubject = q('#compose-subject') || document.querySelector('input[placeholder="主题（必填）"]')
  const fmtBody = q('#compose-body') || document.querySelector('textarea[placeholder*="正文"]')
  const fmtSendBtn = qa('button').find((b) => b.textContent.trim() === '发送')
  setInput(fmtSubject, '格式校验测试')
  setInput(fmtBody, 'hello')
  // 空收件人：不发请求，提示“请填写收件人”。
  let sendBefore = sendCount()
  setInput(fmtTo, '')
  click(fmtSendBtn)
  await sleep(500)
  check('发信校验：空收件人点发送不发请求', sendCount() === sendBefore)
  check('发信校验：空收件人提示“请填写收件人”', text().includes('请填写收件人'))
  // 非法收件人：不发请求，提示格式不正确并点名该地址。
  sendBefore = sendCount()
  setInput(fmtTo, 'not-an-email')
  click(fmtSendBtn)
  await sleep(500)
  check('发信校验：收件人 not-an-email 点发送不发请求', sendCount() === sendBefore)
  check('发信校验：非法收件人提示格式不正确并点名该地址', text().includes('收件人邮箱格式不正确') && text().includes('not-an-email'))
  // 多收件人其一非法：不发请求。
  sendBefore = sendCount()
  setInput(fmtTo, 'a@example.com, not-an-email')
  click(fmtSendBtn)
  await sleep(500)
  check('发信校验：多收件人其一非法时不发送', sendCount() === sendBefore)
  check('发信校验：多收件人其一非法时提示格式不正确', text().includes('收件人邮箱格式不正确'))
  // 非法抄送：不发请求（收件人合法）。
  sendBefore = sendCount()
  setInput(fmtTo, 'a@example.com')
  setInput(fmtCc, 'bad-cc')
  click(fmtSendBtn)
  await sleep(500)
  check('发信校验：抄送格式非法时不发送', sendCount() === sendBefore)
  check('发信校验：非法抄送提示格式不正确', text().includes('抄送邮箱格式不正确'))
  // 全角逗号分隔的合法多收件人：正常进入发送流程（mock 201，写信窗关闭）。
  setInput(fmtCc, '')
  setInput(fmtTo, 'a@example.com，b@example.com')
  click(fmtSendBtn)
  await waitFor(() => mock.log.some((e) => e.method === 'POST' && e.path === '/api/messages/send' && e.body?.subject === '格式校验测试'), 10000, '全角逗号多收件人发信请求')
  const fwEntry = [...mock.log].reverse().find((e) => e.method === 'POST' && e.path === '/api/messages/send' && e.body?.subject === '格式校验测试')
  check('发信校验：全角逗号分隔的合法多收件人正常发送（to 拆成两项）', Array.isArray(fwEntry?.body?.to) && fwEntry.body.to.length === 2 && fwEntry.body.to.includes('a@example.com') && fwEntry.body.to.includes('b@example.com'), JSON.stringify(fwEntry?.body?.to || ''))
  await waitFor(() => !q('input[placeholder="主题（必填）"]'), 10000, '全角逗号发信后写信窗关闭')

  // 添加邮箱必填与格式校验（用户 2026-11-19 要求：邮件帐号、密码、接收
  // 服务器、发送服务器四项必填，帐号须符合邮箱格式）。侧栏“管理邮箱”
  // → 邮箱管理弹窗 → “添加邮箱”打开添加弹窗，逐项验证：缺项/格式非法
  // 时不发 POST /api/accounts 且有对应提示；四项齐全时正常创建。
  // mock 的 POST /api/accounts 一律回 201，不落库、不改 accountsState，
  // 后续小节不受影响。
  const addCount = () => mock.log.filter((e) => e.method === 'POST' && e.path === '/api/accounts').length
  click(q('button[title="管理邮箱"]'))
  await waitFor(() => text().includes('邮箱管理'), 10000, '邮箱管理弹窗打开')
  click(qa('button').find((b) => b.textContent.trim() === '添加邮箱'))
  await waitFor(() => text().includes('创建时后端会实测 IMAP + SMTP 连通。'), 10000, '添加邮箱弹窗打开')
  const addEmail = q('#add-email')
  const addPw = q('#add-password')
  const addImap = q('#add-imap-host')
  const addSmtp = q('#add-smtp-host')
  const addCreateBtn = () => qa('button').find((b) => b.textContent.trim() === '创建')
  // 防自动填充（用户 2026-11-19 补充要求：添加邮箱时帐号、密码框也不许
  // 浏览器自动填充）。手法同设置弹窗密码框：未聚焦时 readonly，聚焦后
  // 才可编辑；帐号框本来就是 autocomplete="off"，密码框去掉 new-password
  // 信号。jsdom 模拟不出浏览器自动填充，只断言静态属性与手动输入流程。
  check('添加邮箱防自动填充：打开时帐号框为空', !!addEmail && addEmail.value === '', addEmail?.value || '')
  check('添加邮箱防自动填充：打开时密码框为空', !!addPw && addPw.value === '', addPw?.value || '')
  check('添加邮箱防自动填充：帐号框未聚焦时只读', !!addEmail && addEmail.hasAttribute('readonly'))
  check('添加邮箱防自动填充：密码框未聚焦时只读', !!addPw && addPw.hasAttribute('readonly'))
  check('添加邮箱防自动填充：帐号框 autocomplete="off"', !!addEmail && addEmail.getAttribute('autocomplete') === 'off', `autocomplete=${addEmail?.getAttribute('autocomplete')}`)
  check('添加邮箱防自动填充：密码框不再声明 new-password', !!addPw && addPw.getAttribute('autocomplete') !== 'new-password' && addPw.getAttribute('name') !== 'new-password', `autocomplete=${addPw?.getAttribute('autocomplete')} name=${addPw?.getAttribute('name')}`)
  addEmail.focus()
  await sleep(300)
  check('添加邮箱防自动填充：帐号框聚焦后解除只读', !!addEmail && !addEmail.hasAttribute('readonly'))
  addPw.focus()
  await sleep(300)
  check('添加邮箱防自动填充：密码框聚焦后解除只读', !!addPw && !addPw.hasAttribute('readonly'))
  // 四项全空：不发请求，提示先填邮箱地址。
  let addBefore = addCount()
  click(addCreateBtn())
  await sleep(500)
  check('添加邮箱：四项全空点创建不发请求', addCount() === addBefore)
  check('添加邮箱：四项全空提示“请填写邮箱地址”', text().includes('请填写邮箱地址。'))
  // 帐号格式非法：不发请求，提示格式不正确。
  addBefore = addCount()
  setInput(addEmail, 'not-an-email')
  click(addCreateBtn())
  await sleep(500)
  check('添加邮箱：帐号 not-an-email 点创建不发请求', addCount() === addBefore)
  check('添加邮箱：帐号格式非法提示“邮箱格式不正确”', text().includes('邮箱格式不正确'))
  // 密码为空：邮箱合法时自动填入 163 预设服务器（mock），再点创建应卡在密码。
  setInput(addEmail, 'test@163.com')
  await waitFor(() => q('#add-imap-host')?.value === 'imap.163.com', 10000, '输完 163 邮箱自动填入服务器')
  addBefore = addCount()
  click(addCreateBtn())
  await sleep(500)
  check('添加邮箱：密码为空点创建不发请求', addCount() === addBefore)
  check('添加邮箱：密码为空提示“请填写密码”', text().includes('请填写密码'))
  // 接收服务器为空：密码填好、清空 IMAP 地址，应点名 IMAP。
  setInput(addPw, 'x')
  setInput(addImap, '')
  addBefore = addCount()
  click(addCreateBtn())
  await sleep(500)
  check('添加邮箱：接收服务器为空点创建不发请求', addCount() === addBefore)
  check('添加邮箱：接收服务器为空提示点名 IMAP', text().includes('请填写接收服务器（IMAP）地址。'))
  // 发送服务器为空：IMAP 补回、清空 SMTP 地址，应点名 SMTP。
  setInput(addImap, 'imap.163.com')
  setInput(addSmtp, '')
  addBefore = addCount()
  click(addCreateBtn())
  await sleep(500)
  check('添加邮箱：发送服务器为空点创建不发请求', addCount() === addBefore)
  check('添加邮箱：发送服务器为空提示点名 SMTP', text().includes('请填写发送服务器（SMTP）地址。'))
  // 四项齐全：正常创建（mock 201），添加弹窗关闭、提示添加成功。
  setInput(addSmtp, 'smtp.163.com')
  click(addCreateBtn())
  await waitFor(() => mock.log.some((e) => e.method === 'POST' && e.path === '/api/accounts' && e.body?.email === 'test@163.com'), 10000, '四项齐全创建请求')
  const addEntry = [...mock.log].reverse().find((e) => e.method === 'POST' && e.path === '/api/accounts' && e.body?.email === 'test@163.com')
  check('添加邮箱：四项齐全时发创建请求且带齐服务器', addEntry?.body?.imapHost === 'imap.163.com' && addEntry?.body?.smtpHost === 'smtp.163.com', JSON.stringify(addEntry?.body || ''))
  await waitFor(() => !text().includes('创建时后端会实测 IMAP + SMTP 连通。'), 10000, '创建成功后添加弹窗关闭')
  check('添加邮箱：创建成功提示“邮箱添加成功”', text().includes('邮箱添加成功'))
  click(qa('button').find((b) => b.textContent.trim() === '取消'))
  await waitFor(() => !text().includes('邮箱管理'), 10000, '邮箱管理弹窗关闭')

  // 8. 写信发送
  click(q('#btn-compose'))
  await waitFor(() => q('#compose-to, input[placeholder*="收件人"]'), 10000, '写信弹窗')
  const toInput = document.querySelector('#compose-to') || q('input[placeholder*="收件人"]')
  setInput(toInput, 'a@example.com')
  setInput(q('#compose-subject') || document.querySelector('input[placeholder="主题（必填）"]'), '冒烟测试')
  setInput(q('#compose-body') || document.querySelector('textarea[placeholder*="正文"]'), 'hello')
  // 审计 #14 BLOCKER：保存失败时“存草稿”须报错且不关窗——以前 autosaveDraft
  // 返回 void 且 catch 静默吞错，saveDraft 照样关窗切视图，失败和成功毫无区别。
  mock.setDraftCreateFail(true)
  click(qa('button').find((b) => b.textContent.trim() === '存草稿'))
  await waitFor(() => text().includes('草稿保存失败，请重试'), 10000, '保存失败提示')
  check('审计 #14 BLOCKER：POST /api/drafts 500 时点“存草稿”，弹窗不关闭', !!q('input[placeholder="主题（必填）"]'))
  check('审计 #14 BLOCKER：POST /api/drafts 500 时点“存草稿”，显示“草稿保存失败，请重试”', text().includes('草稿保存失败，请重试'))
  // 审计 #15 MED-1：保存失败时点 X/取消也须有关闭出口——以前 close() 只报错
  // 不关窗，X/取消都没有第二条关闭路径，零邮箱时窗口永远关不掉。
  // 先点“取消”：应弹出“放弃未保存的改动”确认框，写信窗仍开着。
  click(qa('button').find((b) => b.textContent.trim() === '取消'))
  await waitFor(() => text().includes('放弃未保存的改动'), 10000, '保存失败时点取消弹出放弃确认')
  check('审计 #15 MED-1：保存失败时点“取消”，弹出放弃未保存改动的确认框', text().includes('放弃未保存的改动'))
  check('审计 #15 MED-1：确认框出现时写信窗仍开着（没静默丢弃）', !!q('input[placeholder="主题（必填）"]'))
  // 确认框里点“取消”：应留在写信窗里（确认框消失、写信窗还在）。
  const confirmTextEl = [...document.querySelectorAll('p')].find((el) => el.textContent.includes('放弃未保存的改动'))
  const confirmRoot = confirmTextEl?.closest('.fixed.inset-0')
  click(confirmRoot?.querySelector('button'))
  await waitFor(() => !text().includes('放弃未保存的改动'), 10000, '确认框取消后消失')
  check('审计 #15 MED-1：确认框点“取消”，写信窗仍开着（可继续编辑/重试）', !!q('input[placeholder="主题（必填）"]'))
  // 再点 X（右上角关闭）：确认框应再次出现，点“确定”放弃改动并关闭。
  const subjectInput = q('input[placeholder="主题（必填）"]')
  const composeRoot = subjectInput?.closest('.fixed.inset-0')
  click(composeRoot?.querySelector('button[aria-label="关闭"]'))
  await waitFor(() => text().includes('放弃未保存的改动'), 10000, '保存失败时点 X 弹出放弃确认')
  click(qa('button').find((b) => b.textContent.trim() === '确定'))
  await waitFor(() => !q('input[placeholder="主题（必填）"]'), 10000, '确认放弃后写信窗关闭')
  check('审计 #15 MED-1：保存失败时点 X 再点“确定”，写信窗关闭（放弃改动）', !q('input[placeholder="主题（必填）"]'))
  // 关掉失败开关，重开写信窗再存一次：应成功关窗、草稿落盘（之后重开写信窗继续原有的发信流程）。
  mock.setDraftCreateFail(false)
  click(q('#btn-compose'))
  await waitFor(() => q('#compose-to, input[placeholder*="收件人"]'), 10000, '写信弹窗（放弃关闭后重开）')
  setInput(document.querySelector('#compose-to') || q('input[placeholder*="收件人"]'), 'a@example.com')
  setInput(q('#compose-subject') || document.querySelector('input[placeholder="主题（必填）"]'), '冒烟测试')
  setInput(q('#compose-body') || document.querySelector('textarea[placeholder*="正文"]'), 'hello')
  click(qa('button').find((b) => b.textContent.trim() === '存草稿'))
  await waitFor(() => !q('input[placeholder="主题（必填）"]'), 10000, '重试存草稿后写信窗关闭')
  check('审计 #14 BLOCKER：失败开关关闭后重试存草稿，写信窗关闭', !q('input[placeholder="主题（必填）"]'))
  click(q('#btn-compose'))
  await waitFor(() => q('#compose-to, input[placeholder*="收件人"]'), 10000, '写信弹窗（重试后重开）')
  setInput(document.querySelector('#compose-to') || q('input[placeholder*="收件人"]'), 'a@example.com')
  setInput(q('#compose-subject') || document.querySelector('input[placeholder="主题（必填）"]'), '冒烟测试')
  setInput(q('#compose-body') || document.querySelector('textarea[placeholder*="正文"]'), 'hello')
  const sendBtn = qa('button').find((b) => b.textContent.trim() === '发送')
  click(sendBtn)
  // 审计 #11 H1 回复测试里已先发过一封：等本次（主题“冒烟测试”）的 send 记录出现，
  // 不能只等任意一条 send（会因上一封的记录立即返回、取错条目）。
  await waitFor(() => mock.log.some((e) => e.method === 'POST' && e.path === '/api/messages/send' && (e.body?.subject === '冒烟测试' || (e.raw || '').includes('冒烟测试'))), 10000, '发信请求')
  const sendEntry = [...mock.log].reverse().find((e) => e.method === 'POST' && e.path === '/api/messages/send' && (e.body?.subject === '冒烟测试' || (e.raw || '').includes('冒烟测试')))
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

  // 审计 #17 LOW-2：文件夹快照之和与账号端点值对不上时，账号角标不应被
  // 快照静默改写，应触发一次 loadAccounts 重对。mock 里账号 2 的端点值
  // 仍是 (1)（mock 在标已读时不递减服务端计数，与真实后端不同——真实
  // 后端读信会重算；这里只验证“对不上时不改写 + 触发重对”的机制）。
  // 先把文件夹快照单方面抬到 5（只改 folders，不动 accounts），再用
  // mail-deleted 事件触发文件夹重载对账。
  const accountsReqsBefore = mock.log.filter((e) => e.method === 'GET' && e.path === '/api/accounts').length
  mock.setFoldersUnreadSkew(2, 21, 5)
  mock.emitMailDeleted({ messageId: 999 })
  await waitFor(() => mock.log.filter((e) => e.method === 'GET' && e.path === '/api/accounts').length > accountsReqsBefore, 10000, '对账触发 loadAccounts')
  const accountsReqsAfter = mock.log.filter((e) => e.method === 'GET' && e.path === '/api/accounts').length
  const acct2Row = qa('#account-list .acct-row').find((el) => el.textContent.includes('luck534@163.com'))
  check('LOW-2：快照与端点对不上时触发一次 loadAccounts 重对', accountsReqsAfter === accountsReqsBefore + 1, `GET /api/accounts ${accountsReqsBefore}→${accountsReqsAfter}`)
  check('LOW-2：抬高的快照和 (5) 没有改写账号角标', !!acct2Row && !acct2Row.textContent.includes('(5)'), acct2Row?.textContent || '')

  // 旧密码禁止自动填入（用户 2026-11-19 要求：修改密码时旧密码必须手动填写）。
  // 根因是浏览器自动填充：旧密码框当时写着 name/autocomplete="current-password"，
  // 又配了隐藏用户名诱饵框，浏览器一打开设置就把已保存的登录密码填进来
  // （黄底 + 圆点）；前端 ref 本来就是空的，从未主动回填。修复复用搜索框的
  // 防自动填充手法——未聚焦时 readonly，聚焦后才可编辑，同时去掉
  // current-password 的 name/autocomplete 信号。
  // 注意：jsdom 模拟不出浏览器的自动填充行为，下面只断言防填充的静态属性
  // 与手动输入流程；真实浏览器里“打开设置弹窗确认旧密码框为空、刷新后仍
  // 为空”须在浏览器验证里确认。
  click(q('#desktop-layout button[title="设置"]'))
  await waitFor(() => text().includes('修改密码'), 10000, '设置弹窗')
  const oldPw = q('input[placeholder="当前密码"]')
  check('旧密码防自动填充：打开设置时旧密码框为空', !!oldPw && oldPw.value === '', oldPw?.value || '')
  check('旧密码防自动填充：未聚焦时只读（浏览器不自动填只读框）', !!oldPw && oldPw.hasAttribute('readonly'))
  check('旧密码防自动填充：不再声明 current-password（不招自动填充）', !!oldPw && oldPw.getAttribute('autocomplete') !== 'current-password' && oldPw.getAttribute('name') !== 'current-password', `autocomplete=${oldPw?.getAttribute('autocomplete')} name=${oldPw?.getAttribute('name')}`)
  // 聚焦后解除只读，手动输入旧密码应能正常提交改密。
  oldPw.focus()
  await sleep(300)
  check('旧密码防自动填充：聚焦后解除只读、可手动输入', !!oldPw && !oldPw.hasAttribute('readonly'))
  // 审计 #19 LOW-2：改密码须前端先拦空旧密码——用户要求旧密码“必须手动填写”，
  // 空着点“修改密码”不应发请求，只应提示。此时旧密码框仍是空的（刚聚焦、
  // 尚未输入），新密码与确认框填好，点修改密码应被拦住。
  const pwCountBefore = mock.log.filter((e) => e.method === 'POST' && e.path === '/api/auth/change-password').length
  setInput(q('input[placeholder="新密码（至少 8 位）"]'), 'new-password-123')
  setInput(q('input[placeholder="确认新密码"]'), 'new-password-123')
  click(qa('button').find((b) => b.textContent.trim() === '修改密码'))
  await sleep(500)
  check('LOW-2：旧密码空着点“修改密码”不发改密请求', mock.log.filter((e) => e.method === 'POST' && e.path === '/api/auth/change-password').length === pwCountBefore)
  check('LOW-2：旧密码空时提示“请填写当前密码”', text().includes('请填写当前密码'))
  setInput(oldPw, 'old-password')
  setInput(q('input[placeholder="新密码（至少 8 位）"]'), 'new-password-123')
  setInput(q('input[placeholder="确认新密码"]'), 'new-password-123')
  click(qa('button').find((b) => b.textContent.trim() === '修改密码'))
  await waitFor(() => mock.log.some((e) => e.method === 'POST' && e.path === '/api/auth/change-password'), 10000, '改密请求')
  const pwEntry = [...mock.log].reverse().find((e) => e.method === 'POST' && e.path === '/api/auth/change-password')
  check('旧密码防自动填充：手动输入旧密码后改密请求带上输入的旧密码', pwEntry?.body?.current === 'old-password' && pwEntry?.body?.next === 'new-password-123', JSON.stringify(pwEntry?.body || ''))
  await waitFor(() => text().includes('密码已修改'), 10000, '改密成功提示')
  check('旧密码防自动填充：改密成功提示“密码已修改”', text().includes('密码已修改'))
  check('旧密码防自动填充：改密成功后旧密码框清空', q('input[placeholder="当前密码"]')?.value === '')
  // 新密码、确认新密码同样禁止自动填入（用户 2026-11-19 补充要求）。
  // 改密成功后三个框都被清空、焦点已移到按钮上（失焦→只读恢复），
  // 在此直接断言新密码框与确认框的防填充静态属性，再聚焦验证可手动输入。
  const newPw = q('input[placeholder="新密码（至少 8 位）"]')
  const confirmPw = q('input[placeholder="确认新密码"]')
  check('新密码防自动填充：改密成功后新密码框为空', !!newPw && newPw.value === '', newPw?.value || '')
  check('新密码防自动填充：未聚焦时只读', !!newPw && newPw.hasAttribute('readonly'))
  check('新密码防自动填充：不再声明 new-password', !!newPw && newPw.getAttribute('autocomplete') !== 'new-password' && newPw.getAttribute('name') !== 'new-password', `autocomplete=${newPw?.getAttribute('autocomplete')} name=${newPw?.getAttribute('name')}`)
  check('确认新密码防自动填充：改密成功后确认框为空', !!confirmPw && confirmPw.value === '', confirmPw?.value || '')
  check('确认新密码防自动填充：未聚焦时只读', !!confirmPw && confirmPw.hasAttribute('readonly'))
  check('确认新密码防自动填充：不再声明 new-password', !!confirmPw && confirmPw.getAttribute('autocomplete') !== 'new-password' && confirmPw.getAttribute('name') !== 'new-password', `autocomplete=${confirmPw?.getAttribute('autocomplete')} name=${confirmPw?.getAttribute('name')}`)
  // 聚焦后解除只读，三个框都手动输入、再改一次密，验证手动输入流程全程可用。
  const oldPw2 = q('input[placeholder="当前密码"]')
  oldPw2.focus()
  await sleep(300)
  newPw.focus()
  await sleep(300)
  check('新密码防自动填充：聚焦后解除只读、可手动输入', !!newPw && !newPw.hasAttribute('readonly'))
  confirmPw.focus()
  await sleep(300)
  check('确认新密码防自动填充：聚焦后解除只读、可手动输入', !!confirmPw && !confirmPw.hasAttribute('readonly'))
  setInput(oldPw2, 'old-password')
  setInput(newPw, 'new-password-456')
  setInput(confirmPw, 'new-password-456')
  click(qa('button').find((b) => b.textContent.trim() === '修改密码'))
  await waitFor(() => mock.log.filter((e) => e.method === 'POST' && e.path === '/api/auth/change-password').length >= 2, 10000, '第二次改密请求')
  const pwEntry2 = [...mock.log].reverse().find((e) => e.method === 'POST' && e.path === '/api/auth/change-password')
  check('新密码防自动填充：三个框手动输入后改密请求带上输入的值', pwEntry2?.body?.current === 'old-password' && pwEntry2?.body?.next === 'new-password-456', JSON.stringify(pwEntry2?.body || ''))
  await waitFor(() => text().includes('密码已修改'), 10000, '第二次改密成功提示')
  const settingsRoot = [...document.querySelectorAll('h3')].find((el) => el.textContent.includes('修改密码'))?.closest('.fixed.inset-0')
  click(settingsRoot?.querySelector('button[aria-label="关闭"]'))
  await waitFor(() => !text().includes('修改密码'), 10000, '设置弹窗关闭')
  check('旧密码防自动填充：点 X 关闭设置弹窗', !text().includes('修改密码'))

  // 审计 #22 LOW-1：退出重登后首次加载不应闪“这里没有邮件”——以前
  // resetSessionState 只清列表、不把 loading 置回 true，重登时 init 先
  // await loadAccounts/loadSettings、再 restoreView → loadMessages 才置
  // loading=true，这段窗口里空态分支先闪一下。修法是会话重置时回到“加载中”。
  // 把 /api/accounts 拖慢 600ms 拉宽重登 init 的窗口（复现审计员探针），
  // 采样期间列表区应一直是“加载中…”，绝不能出现“这里没有邮件”。
  click(q('button[title="退出系统"]'))
  await waitFor(() => q('input[autocomplete="username"]'), 10000, '退出后回登录页')
  mock.setAccountsDelayMs(600)
  setInput(q('input[autocomplete="username"]'), 'tester')
  setInput(q('input[type="password"]'), 'correct-password')
  click(q('button[type="submit"]'))
  let sawLoading22 = false
  let sawEmpty22 = false
  const sampleEnd22 = Date.now() + 1500
  while (Date.now() < sampleEnd22) {
    const t = text()
    if (t.includes('加载中…')) sawLoading22 = true
    if (t.includes('这里没有邮件')) sawEmpty22 = true
    await sleep(10)
  }
  mock.setAccountsDelayMs(0)
  check('LOW-1：退出重登、init 等待期间列表显示“加载中…”', sawLoading22)
  check('LOW-1：退出重登、init 等待期间不闪“这里没有邮件”', !sawEmpty22)
  await waitFor(() => text().includes('Socket.io 新邮件'), 10000, '重登后列表加载完成')
  check('LOW-1：重登后列表正常加载回来（Socket.io 新邮件）', text().includes('Socket.io 新邮件'))

  await mock.close()
  dom.window.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) { console.log('失败项：', failed.map((f) => f.name).join('；')); process.exit(1) }
  process.exit(0)
}

main().catch((e) => { console.error('SMOKE 异常：', e); process.exit(1) })
