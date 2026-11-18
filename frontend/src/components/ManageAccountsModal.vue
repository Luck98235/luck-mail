<template>
  <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div class="bg-white rounded-lg shadow-xl w-[880px] max-w-full flex flex-col overflow-hidden max-h-[92vh]">
      <div class="flex items-center justify-between px-5 py-3 border-b border-blue-100">
        <span class="font-bold text-slate-700">邮箱管理 <span class="text-xs font-normal text-slate-400 ml-1">共 {{ rows.length }} 个邮箱</span></span>
        <button class="text-slate-400 hover:text-slate-600" aria-label="关闭" @click="close"><i class="fa-solid fa-xmark"></i></button>
      </div>

      <div class="flex-1 min-h-0 p-5 overflow-y-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="text-xs text-slate-400 border-b border-slate-100">
              <th class="text-left font-medium py-2 w-8"></th>
              <th class="text-left font-medium py-2 w-10">序号</th>
              <th class="text-left font-medium py-2">邮箱</th>
              <th class="text-left font-medium py-2">备注名</th>
              <th class="text-left font-medium py-2 w-20">排序</th>
              <th class="text-right font-medium py-2">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, i) in rows" :key="row.id"
              draggable="true" class="border-b border-slate-50 hover:bg-blue-50/50"
              :class="{ 'opacity-50': row._deleted }"
              @dragstart="dragIndex = i" @dragover.prevent @drop="onDrop(i)" @dragend="dragIndex = null"
            >
              <td class="py-2 text-slate-300 cursor-grab" title="拖拽排序"><i class="fa-solid fa-grip-vertical"></i></td>
              <td class="py-2 pr-2 text-xs text-slate-400 tabular-nums">{{ String(i + 1).padStart(2, '0') }}</td>
              <td class="py-2 pr-2">
                <div class="truncate max-w-[260px]" :class="{ 'line-through': row._deleted }">{{ row.email }}</div>
                <div class="text-[11px]" :class="row.enabled === false ? 'text-amber-500' : (row.status === 'error' ? 'text-red-500' : 'text-slate-400')">
                  {{ row._deleted ? '待删除' : row.enabled === false ? '已停用' : row.status === 'error' ? (row.error || '连接异常') : row.status === 'syncing' ? '同步中…' : '正常' }}
                </div>
              </td>
              <td class="py-2 pr-2">
                <input v-model="row.displayName" type="text" placeholder="备注名（选填）" :disabled="row._deleted" class="w-full border border-slate-200 rounded px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-blue-400 focus:border-blue-400 disabled:bg-slate-50">
              </td>
              <td class="py-2">
                <div class="flex gap-1">
                  <button class="w-7 h-7 rounded hover:bg-slate-100 text-slate-500 disabled:opacity-30" :disabled="i === 0 || row._deleted" title="上移" @click="move(i, -1)"><i class="fa-solid fa-chevron-up text-xs"></i></button>
                  <button class="w-7 h-7 rounded hover:bg-slate-100 text-slate-500 disabled:opacity-30" :disabled="i === rows.length - 1 || row._deleted" title="下移" @click="move(i, 1)"><i class="fa-solid fa-chevron-down text-xs"></i></button>
                </div>
              </td>
              <td class="py-2 text-right whitespace-nowrap">
                <button class="text-blue-500 hover:text-blue-600 text-xs px-1.5" :disabled="row._deleted || testingId !== null" @click="testRow(row)">{{ testingId === row.id ? '测试中…' : '测试' }}</button>
                <button class="text-blue-500 hover:text-blue-600 text-xs px-1.5" :disabled="row._deleted" @click="editRow(row)">邮箱设置</button>
                <button class="text-xs px-1.5" :class="row.enabled === false ? 'text-green-600 hover:text-green-700' : 'text-amber-500 hover:text-amber-600'" :disabled="row._deleted" @click="row.enabled = row.enabled === false ? true : false">
                  {{ row.enabled === false ? '启用' : '停用' }}
                </button>
                <button class="text-red-500 hover:text-red-600 text-xs px-1.5" @click="toggleDelete(row)">{{ row._deleted ? '撤销' : '删除' }}</button>
              </td>
            </tr>
            <tr v-if="!rows.length">
              <td colspan="6" class="py-6 text-center text-xs text-slate-400">还没有邮箱，点下方“添加邮箱”。</td>
            </tr>
          </tbody>
        </table>
        <p v-if="error" class="text-xs text-red-500 bg-red-50 border border-red-100 rounded-lg px-3 py-2 mt-3">{{ error }}</p>
      </div>

      <div class="flex items-center justify-between px-5 py-3 border-t border-blue-100 bg-slate-50/50">
        <div class="flex items-center gap-2">
          <button class="px-4 py-2 rounded-md text-sm bg-green-500 hover:bg-green-600 text-white font-medium" @click="addOpen = true">
            <i class="fa-solid fa-plus mr-1"></i>添加邮箱
          </button>
          <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100 border border-slate-200 bg-white font-medium disabled:opacity-60" :disabled="exporting || !rows.length" @click="exportAll">
            <i class="fa-solid fa-file-export mr-1"></i>{{ exporting ? '导出中…' : '导出全部邮箱' }}
          </button>
          <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100 border border-slate-200 bg-white font-medium disabled:opacity-60" :disabled="downloadingTemplate" @click="downloadTemplate">
            <i class="fa-solid fa-file-arrow-down mr-1"></i>{{ downloadingTemplate ? '下载中…' : '下载导入模板' }}
          </button>
          <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100 border border-slate-200 bg-white font-medium disabled:opacity-60" :disabled="importing" @click="importInput?.click()">
            <i class="fa-solid fa-file-import mr-1"></i>{{ importing ? '导入中…' : '导入' }}
          </button>
          <input ref="importInput" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" class="hidden" @change="onImportFile" />
        </div>
        <div class="flex items-center gap-2">
          <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" @click="close">取消</button>
          <button class="px-5 py-2 rounded-md text-sm bg-blue-800 hover:bg-blue-900 text-white font-medium disabled:opacity-60" :disabled="busy" @click="confirm">{{ busy ? '保存中…' : '确定' }}</button>
        </div>
      </div>
    </div>
  </div>

  <!-- 添加邮箱 / 邮箱设置弹窗（复用） -->
  <AddAccountModal :open="addOpen" :editing="editingRow" @close="addOpen = false; editingRow = null" @back="addOpen = false; editingRow = null" @saved="onAccountSaved" />
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { api, ApiError } from '../api'
import { downloadBlob } from '../utils'
import { useMailStore } from '../stores/mail'
import AddAccountModal from './AddAccountModal.vue'
import type { Account } from '../types'

const props = defineProps({ open: { type: Boolean, default: false } })
const emit = defineEmits(['close'])
const mail = useMailStore()

type ManageRow = Account & { _deleted: boolean }

const rows = ref<ManageRow[]>([])
const dragIndex = ref<number | null>(null)
const busy = ref<boolean>(false)
const error = ref<string>('')
const addOpen = ref<boolean>(false)
const editingRow = ref<Account | null>(null)
const testingId = ref<number | null>(null) // 正在测试连通的邮箱 id（同一时间只测一个）
const exporting = ref<boolean>(false) // 正在导出全部邮箱
const downloadingTemplate = ref<boolean>(false) // 正在下载导入模板
const importing = ref<boolean>(false) // 正在批量导入邮箱
const importInput = ref<HTMLInputElement | null>(null) // 导入文件选择框

watch(() => props.open, (v) => {
  if (!v) return
  error.value = ''
  // 暂存副本：确定才写回，取消直接丢弃
  rows.value = mail.accounts.map((a) => ({ ...a, displayName: a.displayName || '', _deleted: false }))
})

function move(i: number, dir: number): void {
  const j = i + dir
  if (j < 0 || j >= rows.value.length) return
  const [row] = rows.value.splice(i, 1)
  rows.value.splice(j, 0, row)
}
function onDrop(i: number): void {
  if (dragIndex.value == null || dragIndex.value === i) return
  const [row] = rows.value.splice(dragIndex.value, 1)
  rows.value.splice(i, 0, row)
  dragIndex.value = null
}
function toggleDelete(row: ManageRow): void { row._deleted = !row._deleted }
// 测单个邮箱连通（IMAP + SMTP）：不用进邮箱设置，直接在管理列表里点“测试”。
async function testRow(row: ManageRow): Promise<void> {
  if (testingId.value !== null) return
  error.value = ''
  testingId.value = row.id
  try {
    const r = await api.testAccount(row.id)
    if (r.imapOk && r.smtpOk) mail.showToast(`${row.email} 连通正常`)
    else error.value = `${row.email} 连通测试未通过：IMAP ${r.imapOk ? '正常' : '失败'}，SMTP ${r.smtpOk ? '正常' : '失败'}。${r.error || ''}`
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '测试失败，请重试。'
  } finally {
    testingId.value = null
  }
}
function editRow(row: ManageRow): void {
  editingRow.value = mail.accounts.find((a) => a.id === row.id) || null
  addOpen.value = true
}

// 重建 rows：以服务器最新账号为准；但表格里未保存的改动（备注名/启用/删除标记/顺序）
// 要合并回来，避免一次导入/保存把用户正在改的表格内容丢掉。
// 例外：excludeId 指定的行（刚在邮箱设置里保存过的）以服务器值为准，不覆盖。
function rebuildRowsPreservingEdits(excludeId: number | null = null): void {
  const prev = new Map(rows.value.map((r) => [r.id, r]))
  const prevOrder = rows.value.map((r) => r.id)
  const fresh = mail.accounts.map((a) => ({ ...a, displayName: a.displayName || '', _deleted: false }))
  const merged: ManageRow[] = []
  for (const id of prevOrder) {
    const f = fresh.find((x) => x.id === id)
    if (!f) continue
    if (id !== excludeId) {
      const old = prev.get(id)!
      f.displayName = old.displayName
      f.enabled = old.enabled
      f._deleted = old._deleted
    }
    merged.push(f)
  }
  for (const f of fresh) if (!prev.has(f.id)) merged.push(f)
  rows.value = merged
}
// 表格里是否还有未保存的改动（备注名/启用/删除标记/顺序任一与服务器不一致）
function hasUnsavedEdits(): boolean {
  if (rows.value.some((r) => r._deleted)) return true
  let order = 0
  for (const row of rows.value) {
    if (row._deleted) continue
    const orig = mail.accounts.find((a) => a.id === row.id)
    if (!orig) return true
    if ((row.displayName || '') !== (orig.displayName || '') || row.enabled !== orig.enabled || orig.sortOrder !== order) return true
    order++
  }
  return false
}
async function onAccountSaved(): Promise<void> {
  const savedId = editingRow.value?.id ?? null
  addOpen.value = false
  editingRow.value = null
  await mail.loadAccounts()
  rebuildRowsPreservingEdits(savedId)
  if (hasUnsavedEdits()) mail.showToast('邮箱管理里的改动尚未保存，点“确定”保存')
}

async function confirm(): Promise<void> {
  error.value = ''
  busy.value = true
  try {
    for (const row of rows.value) {
      if (row._deleted) {
        await api.deleteAccount(row.id)
        continue
      }
      const orig = mail.accounts.find((a) => a.id === row.id)
      if (!orig) continue
      const changes: Record<string, unknown> = {}
      if ((row.displayName || '') !== (orig.displayName || '')) changes.displayName = row.displayName
      if (row.enabled !== orig.enabled) changes.enabled = row.enabled
      if (Object.keys(changes).length) await api.updateAccount(row.id, changes)
    }
    // 排序写回：按未删除行重排（已删除行不占序号，避免排序值留空洞）
    let sortFailed = false
    let order = 0
    for (const row of rows.value) {
      if (row._deleted) continue
      const orig = mail.accounts.find((a) => a.id === row.id)
      if (orig && orig.sortOrder !== order) {
        try { await api.updateAccount(row.id, { sortOrder: order }) } catch { sortFailed = true }
      }
      order++
    }
    await mail.loadAccounts()
    if (sortFailed) {
      // 排序没全存上：重建 rows 回到服务器真实状态，报错留在弹窗里让用户重试
      rows.value = mail.accounts.map((a) => ({ ...a, displayName: a.displayName || '', _deleted: false }))
      error.value = '部分排序未保存，请重试。'
      return
    }
    mail.showToast('邮箱管理已保存')
    close()
  } catch (e) {
    // 部分失败：重载账号并重建 rows，让表格回到服务器真实状态，不留半截改动
    await mail.loadAccounts()
    rows.value = mail.accounts.map((a) => ({ ...a, displayName: a.displayName || '', _deleted: false }))
    error.value = e instanceof ApiError ? e.message : '保存失败，请重试。'
  } finally {
    busy.value = false
  }
}

// 导出全部邮箱为 Excel：字段 序号/邮箱名/授权码/IMAP 服务器/IMAP 端口/SMTP 服务器/SMTP 端口/备注。
async function exportAll(): Promise<void> {
  if (exporting.value || !rows.value.length) return
  exporting.value = true
  try {
    const { blob, filename } = await api.exportAccounts()
    downloadBlob(blob, filename)
    // 计数用未删除行：与表格里显示的有效邮箱一致（已标记删除的不计入）
    const count = rows.value.filter((r) => !r._deleted).length
    mail.showToast(`已导出 ${count} 个邮箱`)
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '导出失败，请重试。'
  } finally {
    exporting.value = false
  }
}

// 下载导入模板：空的 .xlsx，只有表头一行。
async function downloadTemplate(): Promise<void> {
  if (downloadingTemplate.value) return
  downloadingTemplate.value = true
  try {
    const { blob, filename } = await api.downloadImportTemplate()
    downloadBlob(blob, filename)
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '下载失败，请重试。'
  } finally {
    downloadingTemplate.value = false
  }
}

// 批量导入：选填好的导入模板（.xlsx）上传；同名邮箱跳过。
async function onImportFile(ev: Event): Promise<void> {
  const input = ev.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = '' // 允许下次再选同一文件
  if (!file || importing.value) return
  importing.value = true
  try {
    const r = await api.importAccounts(file)
    await mail.loadAccounts() // 刷新列表与左栏序号
    rebuildRowsPreservingEdits() // 新邮箱进表，表格里未保存的改动合并保留
    const parts: string[] = []
    if (r.added > 0) parts.push(`已添加 ${r.added} 个邮箱`)
    if (r.skipped > 0) parts.push(`跳过 ${r.skipped} 个已存在的邮箱`)
    if (r.failed.length > 0) parts.push(`${r.failed.length} 行失败`)
    mail.showToast(parts.length ? parts.join('，') : '没有可导入的邮箱')
    if (r.failed.length > 0) {
      error.value = '导入失败的行：' + r.failed.map((f) => `第 ${f.row} 行 ${f.email || ''}（${f.reason}）`).join('；')
    } else {
      error.value = ''
    }
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '导入失败，请重试。'
  } finally {
    importing.value = false
  }
}

function close(): void { emit('close') }
</script>
