// 通知模块测试：用全局 stub 的 Notification 覆盖合并窗口逻辑，node 直接跑。
//   node scripts/notify-test.mjs
import { readFileSync } from 'node:fs'
import { MailNotifier, isNotifySupported, getNotifyPermission, requestNotifyPermission, NOTIFY_MERGE_MS } from '../src/utils/notify.ts'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const MERGE = 40 // 测试用短窗口（生产默认 3000ms）

// ---- Notification stub：记录每次构造的通知 ----
let created = []
let focusCalls = 0
class FakeNotification {
  static permission = 'granted'
  static async requestPermission() { return FakeNotification.permission }
  constructor(title, options) {
    this.title = title
    this.options = options || {}
    this.closed = false
    this.onclick = null
    created.push(this)
  }
  close() { this.closed = true }
}
function installStubs({ hidden = true, permission = 'granted' } = {}) {
  created = []
  focusCalls = 0
  FakeNotification.permission = permission
  globalThis.Notification = FakeNotification
  globalThis.document = { hidden }
  globalThis.window = { focus: () => { focusCalls += 1 } }
}
function makeHandlers() {
  const calls = { openMessage: [], openInbox: 0 }
  return {
    calls,
    handlers: {
      onOpenMessage: (id) => { calls.openMessage.push(id) },
      onOpenInbox: () => { calls.openInbox += 1 }
    }
  }
}
const on = () => true
const off = () => false

async function main() {
  check('合并窗口常量为 3000ms', NOTIFY_MERGE_MS === 3000, `实际 ${NOTIFY_MERGE_MS}`)

  // 1. 单封：标题=发件人，正文=主题，tag 带 id；点击聚焦并打开该封
  {
    installStubs()
    const { calls, handlers } = makeHandlers()
    const n = new MailNotifier(MERGE)
    n.queue({ id: 101, sender: '张三', subject: '测试主题' }, { isEnabled: on, ...handlers })
    await sleep(120)
    check('单封：只弹一条', created.length === 1, `实际 ${created.length}`)
    const one = created[0]
    check('单封：标题=发件人', one?.title === '张三', `实际 ${one?.title}`)
    check('单封：正文=主题', one?.options.body === '测试主题', `实际 ${one?.options.body}`)
    check('单封：tag 带 id', one?.options.tag === 'luck-mail-101', `实际 ${one?.options.tag}`)
    one.onclick()
    check('单封点击：窗口聚焦', focusCalls === 1, `实际 ${focusCalls}`)
    check('单封点击：打开该封邮件', calls.openMessage.length === 1 && calls.openMessage[0] === 101, `实际 ${JSON.stringify(calls.openMessage)}`)
    check('单封点击：通知关闭', one.closed === true)
  }

  // 2. 多封合并：4 封只弹一条，标题带数量，正文只取前 3 位发件人；点击切收件箱
  {
    installStubs()
    const { calls, handlers } = makeHandlers()
    const n = new MailNotifier(MERGE)
    n.queue({ id: 1, sender: '甲', subject: 's1' }, { isEnabled: on, ...handlers })
    n.queue({ id: 2, sender: '乙', subject: 's2' }, { isEnabled: on, ...handlers })
    n.queue({ id: 3, sender: '丙', subject: 's3' }, { isEnabled: on, ...handlers })
    n.queue({ id: 4, sender: '丁', subject: 's4' }, { isEnabled: on, ...handlers })
    await sleep(120)
    check('多封：只弹一条合并通知', created.length === 1, `实际 ${created.length}`)
    const batch = created[0]
    check('多封：标题=收到 N 封新邮件', batch?.title === '收到 4 封新邮件', `实际 ${batch?.title}`)
    check('多封：正文=前 3 位发件人', batch?.options.body === '甲，乙，丙', `实际 ${batch?.options.body}`)
    check('多封：tag 为 batch', batch?.options.tag === 'luck-mail-batch', `实际 ${batch?.options.tag}`)
    batch.onclick()
    check('合并点击：窗口聚焦', focusCalls === 1, `实际 ${focusCalls}`)
    check('合并点击：切到所有收件箱', calls.openInbox === 1, `实际 ${calls.openInbox}`)
    check('合并点击：不打开单封', calls.openMessage.length === 0)
  }

  // 3. 两批不合并：第一批弹完，第二批另弹一条
  {
    installStubs()
    const { handlers } = makeHandlers()
    const n = new MailNotifier(MERGE)
    n.queue({ id: 1, sender: '甲', subject: 's1' }, { isEnabled: on, ...handlers })
    await sleep(120)
    n.queue({ id: 2, sender: '乙', subject: 's2' }, { isEnabled: on, ...handlers })
    await sleep(120)
    check('两批：各弹一条', created.length === 2, `实际 ${created.length}`)
  }

  // 4. 页面在前台时不弹（只亮红点）
  {
    installStubs({ hidden: false })
    const { handlers } = makeHandlers()
    const n = new MailNotifier(MERGE)
    n.queue({ id: 1, sender: '甲', subject: 's1' }, { isEnabled: on, ...handlers })
    await sleep(120)
    check('前台时不弹通知', created.length === 0, `实际 ${created.length}`)
  }

  // 5. 开关关时不弹
  {
    installStubs()
    const { handlers } = makeHandlers()
    const n = new MailNotifier(MERGE)
    n.queue({ id: 1, sender: '甲', subject: 's1' }, { isEnabled: off, ...handlers })
    await sleep(120)
    check('开关关时不弹通知', created.length === 0, `实际 ${created.length}`)
  }

  // 6. 窗口内关掉开关：到点也不弹（到点时再判断）
  {
    installStubs()
    const { handlers } = makeHandlers()
    let enabled = true
    const n = new MailNotifier(MERGE)
    n.queue({ id: 1, sender: '甲', subject: 's1' }, { isEnabled: () => enabled, ...handlers })
    enabled = false
    await sleep(120)
    check('窗口内关开关：到点不弹', created.length === 0, `实际 ${created.length}`)
  }

  // 7. 权限 default/denied 时不弹
  {
    for (const perm of ['default', 'denied']) {
      installStubs({ permission: perm })
      const { handlers } = makeHandlers()
      const n = new MailNotifier(MERGE)
      n.queue({ id: 1, sender: '甲', subject: 's1' }, { isEnabled: on, ...handlers })
      await sleep(120)
      check(`权限 ${perm} 时不弹通知`, created.length === 0, `实际 ${created.length}`)
    }
  }

  // 8. 权限请求：返回浏览器给的值（不主动弹框，只返回）
  {
    installStubs({ permission: 'default' })
    check('requestPermission 返回 default', (await requestNotifyPermission()) === 'default')
    installStubs({ permission: 'granted' })
    check('requestPermission 返回 granted', (await requestNotifyPermission()) === 'granted')
    check('getNotifyPermission 读当前权限', getNotifyPermission() === 'granted')
    check('isNotifySupported 有 Notification 时为 true', isNotifySupported() === true)
  }

  // 9. Notification 未定义时不报错（Node/旧浏览器）：全部静默跳过
  {
    delete globalThis.Notification
    delete globalThis.document
    let threw = null
    try {
      check('Notification 未定义时 isNotifySupported 为 false', isNotifySupported() === false)
      check('Notification 未定义时权限为 unsupported', getNotifyPermission() === 'unsupported')
      check('Notification 未定义时请求权限返回 unsupported', (await requestNotifyPermission()) === 'unsupported')
      const { handlers } = makeHandlers()
      const n = new MailNotifier(MERGE)
      n.queue({ id: 1, sender: '甲', subject: 's1' }, { isEnabled: on, ...handlers })
      await sleep(120)
    } catch (e) {
      threw = e
    }
    check('Notification 未定义时入队/到点不抛错', threw === null, threw ? String(threw) : '')
  }

  // 10. 跨标签页同步：store 监听 storage 事件，luck-mail-notify 变化时同步 notifyEnabled
  // （静态源码断言，同 noautoopen-test 的做法；真跨标签行为由浏览器验证覆盖）
  {
    const storeSrc = readFileSync(new URL('../src/stores/mail.ts', import.meta.url), 'utf8')
    const hasListener = /window\.addEventListener\('storage'/.test(storeSrc)
      && /e\.key !== NOTIFY_KEY/.test(storeSrc)
      && /notifyEnabled\.value = e\.newValue === '1'/.test(storeSrc)
    check('跨标签页同步：mail.ts 监听 storage 事件同步 notifyEnabled', hasListener)
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) { console.log('失败项：', failed.map((f) => f.name).join('；')); process.exit(1) }
  process.exit(0)
}

main().catch((e) => { console.error('NOTIFY-TEST 异常：', e); process.exit(1) })
