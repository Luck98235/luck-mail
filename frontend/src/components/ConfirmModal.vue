<template>
  <div v-if="mail.confirmRequest" class="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
    <div class="bg-white rounded-lg shadow-xl w-[380px] max-w-full overflow-hidden">
      <div class="px-5 pt-5 pb-4">
        <p class="text-sm text-slate-700 leading-relaxed">{{ mail.confirmRequest.message }}</p>
      </div>
      <div class="flex items-center justify-end gap-2 px-5 py-3 border-t border-blue-100 bg-slate-50/50">
        <button class="px-4 py-2 rounded-md text-sm text-slate-600 hover:bg-slate-100" @click="mail.resolveConfirm(false)">取消</button>
        <button
          class="px-5 py-2 rounded-md text-sm text-white font-medium disabled:opacity-60"
          :class="mail.confirmRequest.danger ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-800 hover:bg-blue-900'"
          @click="mail.resolveConfirm(true)"
        >确定</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useMailStore } from '../stores/mail'

const mail = useMailStore()
</script>
