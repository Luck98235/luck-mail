// 手机/平板右滑返回上一屏（2026-11-18；2026-11-18 09:57 重设计）。
//
// 背景：第一版只用被动监听、从不 preventDefault，结果手机系统自带的
// “从左边缘右滑返回”手势照样触发浏览器后退，而单页应用没有历史记录可退，
// 于是直接退出到浏览器空白页/首页。正确做法是让应用接入浏览器历史：
// mview 每深入一级就 pushState，系统返回手势/返回键触发 popstate，
// 应用按 state 里的 mview 回退一级（见 store.initMobileHistory / goMobileBack）。
//
// 本文件只负责“非边缘”的右滑：从屏幕中部开始的右滑，系统手势不会接管，
// 由这里识别后调 goMobileBack（内部走 history.back()，与 popstate 同步）。
// 从左边缘 32px 内开始的触摸一律忽略，交给系统手势处理，避免一次滑动
// 两边各退一级（应用内退一级 + 浏览器又退一级）。
//
// 触发条件：单指触摸，起始 x >= 32，水平向右滑动 >= 80px，且水平位移明显大于垂直位移。
// 只用 touchstart/touchend/touchcancel（passive），全程不 preventDefault：
// 不干扰垂直滚动、下拉刷新、邮件内链接点击与横向小幅拖动。
// 用途有二：挂在 MobileShell 根元素上（覆盖首页、列表、阅读窗顶栏等主文档区域），
// 以及挂在邮件正文 iframe 的 document 上（iframe 是独立文档，主文档收不到里面的手势）。
export function attachSwipeBack(
  el: HTMLElement | Document,
  onBack: () => void,
  threshold = 80,
): () => void {
  // 左边缘多少 px 内开始的触摸交给系统返回手势（浏览器后退），这里不处理。
  const EDGE_IGNORE_PX = 32
  let startX = 0
  let startY = 0
  let tracking = false

  // 注：监听器参数用 Event（addEventListener 的类型要求），内部再收窄为 TouchEvent。
  // 直接写 (e: TouchEvent) 会报类型错，因为 HTMLElement | Document 的监听器只保证传 Event。
  function onStart(e: Event): void {
    const te = e as TouchEvent
    if (te.touches.length !== 1) { tracking = false; return }
    const t = te.touches[0]
    // 在输入框/下拉框/可编辑区里滑动是编辑、选择操作，不触发返回
    const target = te.target as HTMLElement | null
    if (target && target.closest('input, textarea, select, [contenteditable="true"]')) { tracking = false; return }
    // 正在选文本时不触发返回（避免划选文字时误退回上一屏）
    const doc = el instanceof Document ? el : el.ownerDocument
    const sel = doc?.getSelection?.()
    if (sel && sel.toString()) { tracking = false; return }
    // 从左边缘开始的滑动是系统返回手势的地盘：忽略，等浏览器 popstate。
    if (t.clientX < EDGE_IGNORE_PX) { tracking = false; return }
    startX = t.clientX
    startY = t.clientY
    tracking = true
  }
  function onEnd(e: Event): void {
    if (!tracking) return
    tracking = false
    const t = (e as TouchEvent).changedTouches[0]
    if (!t) return
    const dx = t.clientX - startX
    const dy = t.clientY - startY
    // 向右滑、水平主导、距离够 → 返回上一屏
    if (dx >= threshold && Math.abs(dx) > Math.abs(dy) * 1.5) onBack()
  }
  function onCancel(): void { tracking = false }

  el.addEventListener('touchstart', onStart, { passive: true })
  el.addEventListener('touchend', onEnd, { passive: true })
  el.addEventListener('touchcancel', onCancel, { passive: true })
  return () => {
    el.removeEventListener('touchstart', onStart)
    el.removeEventListener('touchend', onEnd)
    el.removeEventListener('touchcancel', onCancel)
  }
}
