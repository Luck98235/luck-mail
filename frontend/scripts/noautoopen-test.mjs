// 不自动打开回归测试：2026-11-18 用户定夺——全部手动点开。
// 校验 store 源码层面不再有“加载列表时自动打开第一封”的路径，node 直接跑。
//   node scripts/noautoopen-test.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const storeSrc = fs.readFileSync(path.join(here, '../src/stores/mail.ts'), 'utf-8')
const paneSrc = fs.readFileSync(path.join(here, '../src/components/ReadingPane.vue'), 'utf-8')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

// 取某函数体：从函数定义开始，到下一个同级函数定义之前（store 内函数均为 2 空格缩进）。
function fnBody(src, fnStart, nextStart) {
  const a = src.indexOf(fnStart)
  if (a === -1) return null
  const b = src.indexOf(nextStart, a + fnStart.length)
  return b === -1 ? src.slice(a) : src.slice(a, b)
}

// 1. 源码里不再出现 autoOpenFirst（调用参数、裸引用一律不留）。
check('no autoOpenFirst anywhere', !/autoOpenFirst/.test(storeSrc))

// 2. loadMessages 体内不再调用 openMessage（搜/切文件夹/翻页/刷新都不自动打开）。
const loadBody = fnBody(storeSrc, 'async function loadMessages(', '\n  async function goToPage(')
check('loadMessages body found', loadBody !== null)
if (loadBody !== null) check('loadMessages never calls openMessage', !loadBody.includes('openMessage('))

// 3. setSearch 不自动打开，但搜完会清掉不在结果里的选中。
const searchBody = fnBody(storeSrc, 'async function setSearch(', '\n  async function openMessage(')
check('setSearch body found', searchBody !== null)
if (searchBody !== null) {
  check('setSearch has no autoOpenFirst', !searchBody.includes('autoOpenFirst'))
  check('setSearch never calls openMessage', !searchBody.includes('openMessage('))
  check(
    'setSearch clears stale selection',
    searchBody.includes('selectedId.value = null') && searchBody.includes('.some((m) => m.id === selectedId.value)'),
  )
}

// 4. 阅读窗已有空状态（无选中时显示，不用新加）。
check('ReadingPane has empty state', paneSrc.includes('!mail.selectedMessage'))

// 5. 删信/移垃圾后不再自动打开下一封（2026-11-18 定夺扩展：全部手动点开）。
//    autoOpenFirstAfterDelete 函数及全部调用点已删，删完阅读窗回到空状态。
check('no autoOpenFirstAfterDelete anywhere', !storeSrc.includes('autoOpenFirstAfterDelete'))

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
