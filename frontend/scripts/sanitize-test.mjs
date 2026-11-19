// 正文第二遍消毒回归测试（审计 #10 前端 H1-安全）：
//   后端入库时已消过一遍，前端进沙盒 iframe 前再用同配置消一遍
//   （src/utils/sanitize.ts，DOMPurify）。用 jsdom 挂载 dist + mock 后端，
//   打开一封带恶意 bodyHtml 的信，断言 iframe srcdoc 里：
//     - <script> / 事件属性（onerror）/ javascript: 链接 / <style> / <form> 全部被剥离
//     - 正常段落保留
//     - 全部外链统一规范化为 target="_blank" rel="noopener noreferrer"
//   用法：先 npm run build，再 node scripts/sanitize-test.mjs
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

const MALICIOUS_HTML = '<p>正常段落</p>'
  + '<script>alert("xss")</script>'
  + '<img src="x" onerror="alert(2)">'
  + '<a href="javascript:alert(3)">点我</a>'
  + '<a href="https://example.com">外链</a>'
  + '<a href="https://example.com" target="_blank ">尾空格 target</a>'
  + '<style>p{color:red}</style>'
  + '<form><input name="q"></form>'
  // 审计 #11 L5：追踪像素不只 1x1——0 尺寸与隐藏样式的图也要删，正常图保留。
  + '<img src="https://tracker.example.com/pixel-1x1.png" width="1" height="1">'
  + '<img src="https://tracker.example.com/pixel-0x0.png" width="0" height="0">'
  + '<img src="https://tracker.example.com/pixel-style-0.png" style="width:0;height:0">'
  + '<img src="https://tracker.example.com/pixel-hidden.png" style="display:none">'
  + '<img src="https://tracker.example.com/pixel-invisible.png" style="visibility:hidden">'
  + '<img src="https://tracker.example.com/pixel-collapse.png" style="visibility:collapse">'
  + '<img src="https://tracker.example.com/pixel-opacity.png" style="opacity:0">'
  + '<img src="https://tracker.example.com/pixel-opacity-dot.png" style="opacity:.0">'
  + '<img src="https://tracker.example.com/pixel-1dot0.png" style="width:1.0px;height:1.0px">'
  + '<img src="https://tracker.example.com/pixel-0dot0.png" style="width:0.0px;height:0.0px">'
  + '<img src="https://tracker.example.com/normal.png" width="100" height="50" alt="正常图片">'

async function main() {
  const mock = createMockServer()
  const port = await mock.start(0)
  const origin = `http://127.0.0.1:${port}`

  // 往 mock 里推一封带恶意正文的信（收件箱，登录后即在列表里）
  mock.messages.unshift({
    id: 50, accountId: 1, accountEmail: 'zm235@163.com', folderId: 11, folderPath: 'INBOX', uid: 150,
    subject: 'XSS 消毒测试', from: 'evil@example.com', fromName: '', to: ['zm235@163.com'],
    date: new Date().toISOString(), snippet: '恶意正文测试', isRead: true, hasAttachments: false, size: 300,
    bodyHtml: MALICIOUS_HTML
  })

  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  const bundleFile = fs.readdirSync(path.join(DIST, 'assets')).find((f) => f.endsWith('.js'))
  const bundle = fs.readFileSync(path.join(DIST, 'assets', bundleFile), 'utf8')
  const htmlNoModule = html.replace(/<script[^>]*type="module"[^>]*><\/script>/, '')

  const dom = new JSDOM(htmlNoModule, {
    url: `${origin}/`,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    resources: new LocalOnlyLoader(),
    beforeParse(window) {
      window.fetch = (input, init) => fetch(new URL(input, window.location.href), init)
      window.AbortController = AbortController
      window.AbortSignal = AbortSignal
      window.ResizeObserver = class { constructor() {} observe() {} unobserve() {} disconnect() {} }
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

  window.eval(bundle)

  // 登录
  await waitFor(() => q('input[autocomplete="username"]'), 15000, '登录页用户名框')
  setInput(q('input[autocomplete="username"]'), 'tester')
  setInput(q('input[type="password"]'), 'correct-password')
  click(q('button[type="submit"]'))
  await waitFor(() => q('#btn-compose'), 15000, '主界面写信按钮')
  await waitFor(() => text().includes('XSS 消毒测试'), 15000, '恶意测试邮件进列表')

  // 点开这封信，等 iframe srcdoc 落定
  const row = qa('#desktop-layout .group.relative.cursor-pointer').find((el) => el.textContent.includes('XSS 消毒测试'))
  click(row)
  const frame = await waitFor(() => {
    const f = q('iframe[title="邮件正文"]')
    return f && (f.getAttribute('srcdoc') || '').includes('正常段落') ? f : null
  }, 15000, '阅读窗 iframe 渲染')
  const srcdoc = frame.getAttribute('srcdoc') || ''
  const lower = srcdoc.toLowerCase()

  check('消毒：<script> 被剥离', !lower.includes('<script'))
  check('消毒：事件属性 onerror 被剥离', !lower.includes('onerror'))
  check('消毒：javascript: 链接被剥离', !lower.includes('javascript:'))
  // 注意：srcdoc 模板自身带一个 <style>（正文区滚动条/字体样式），
  // 所以不能断言“全无 <style>”；断言邮件里那个 <style> 的内容被剥离，
  // 且 <style> 出现次数仍为模板自带的 1 次。
  check('消毒：邮件内 <style> 被剥离', !srcdoc.includes('color:red') && (srcdoc.match(/<style/g) || []).length === 1)
  check('消毒：<form>/<input> 被剥离', !lower.includes('<form') && !lower.includes('<input'))
  check('消毒：正常段落保留', srcdoc.includes('正常段落'))
  check('消毒：外链统一 target="_blank" rel="noopener noreferrer"',
    srcdoc.includes('href="https://example.com"') && srcdoc.includes('target="_blank"') && srcdoc.includes('rel="noopener noreferrer"'))
  check('消毒：iframe 仍为沙盒（无 allow-scripts）',
    (frame.getAttribute('sandbox') || '').includes('allow-same-origin') && !(frame.getAttribute('sandbox') || '').includes('allow-scripts'))
  // 审计 #11 L5：追踪像素不只 1x1——0 尺寸与隐藏样式的图也要删，正常图保留。
  check('消毒：1x1 追踪像素被删', !srcdoc.includes('pixel-1x1'))
  check('消毒：0x0 追踪像素被删', !srcdoc.includes('pixel-0x0'))
  check('消毒：样式 0 尺寸追踪图被删', !srcdoc.includes('pixel-style-0'))
  check('消毒：display:none 追踪图被删', !srcdoc.includes('pixel-hidden'))
  check('消毒：visibility:hidden 追踪图被删', !srcdoc.includes('pixel-invisible'))
  // 审计 #15 LOW-4：visibility:collapse 也须删，与后端同配置。
  check('消毒：visibility:collapse 追踪图被删', !srcdoc.includes('pixel-collapse'))
  check('消毒：opacity:0 追踪图被删', !srcdoc.includes('pixel-opacity'))
  // 审计 #16 LOW-3 跟进：opacity:.0、width/height:1.0px 与 0.0px 也是合法 CSS 零值，须删。
  check('消毒：opacity:.0 追踪图被删', !srcdoc.includes('pixel-opacity-dot'))
  check('消毒：width/height:1.0px 追踪图被删', !srcdoc.includes('pixel-1dot0'))
  check('消毒：width/height:0.0px 追踪图被删', !srcdoc.includes('pixel-0dot0'))
  check('消毒：正常尺寸图片保留', srcdoc.includes('normal.png'))

  await mock.close()
  dom.window.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) { console.log('失败项：', failed.map((f) => f.name).join('；')); process.exit(1) }
  process.exit(0)
}

main().catch((e) => { console.error('SANITIZE 异常：', e); process.exit(1) })
