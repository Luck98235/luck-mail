// 正文 HTML 第二遍消毒（审计 #10 前端 H1-安全）：后端入库时已用同配置消过一遍，
// 前端在进沙盒 iframe 前再消一遍——allow-same-origin 下消毒是唯一防线，
// 两遍同配置，任一处回归都还有另一层挡着。配置与 backend/src/sanitize.ts
// 保持一致（FORBID_TAGS + ADD_ATTR + 像素钩子 + 链接 rel 兜底），
// 另把全部外链统一规范化为 target="_blank" rel="noopener noreferrer"
//（在 DOMPurify 的 afterSanitizeAttributes 钩子里改属性，不用正则拼字符串；
// 旧的 forceBlankTarget 正则版已删，见 ReadingPane）。
import createDOMPurify from 'dompurify'

const DOMPurify = createDOMPurify(window)

DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.tagName === 'IMG') {
    const img = node as HTMLImageElement
    const w = (img.getAttribute('width') || '').trim()
    const h = (img.getAttribute('height') || '').trim()
    const style = (img.getAttribute('style') || '').toLowerCase()
    // 审计 #11 L5：追踪像素不只 1x1——0 尺寸（width/height 属性或样式为 0）
    // 与隐藏样式（display:none、visibility:hidden|collapse、opacity:0）的图一律删掉。
    // 样式按声明匹配（以 ; 或串首开头），避免 min-width:0 这类声明误伤。
    // 审计 #15 LOW-4：visibility 补 collapse，与后端 sanitize.ts 同配置
    //（以前前端只认 hidden，后端认 hidden|collapse——后端一旦回归，
    // 前端挡不住 collapse 追踪像素）。
    // 审计 #16 LOW-3 跟进：与后端同款放宽——opacity:.0、width/height:1.0px
    // 与 0.0px 都是合法 CSS 零值，旧正则只认字面 0/1px 会漏拦。
    const isPixel =
      (w === '1' && h === '1')
      || (/(^|;)\s*width\s*:\s*1(\.0+)?px/.test(style) && /(^|;)\s*height\s*:\s*1(\.0+)?px/.test(style))
      || w === '0' || h === '0'
      || /(^|;)\s*width\s*:\s*0(\.0+)?(px)?\s*(;|$)/.test(style) || /(^|;)\s*height\s*:\s*0(\.0+)?(px)?\s*(;|$)/.test(style)
      || /(^|;)\s*display\s*:\s*none\s*(;|$)/.test(style)
      || /(^|;)\s*visibility\s*:\s*(hidden|collapse)\s*(;|$)/.test(style)
      || /(^|;)\s*opacity\s*:\s*\.?0+(\.0+)?\s*(;|$)/.test(style)
    if (isPixel) node.remove()
  }
  // 全部链接统一规范化：无论原来有没有 target、写成什么样，一律
  // target="_blank" rel="noopener noreferrer"，防反向 Tabnabbing。
  if (node.tagName === 'A') {
    const a = node as HTMLAnchorElement
    a.setAttribute('target', '_blank')
    a.setAttribute('rel', 'noopener noreferrer')
  }
})

export function sanitizeBodyHtml(html: string): string {
  if (!html) return ''
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: [
      'style', 'form', 'input', 'button', 'select', 'textarea', 'iframe',
      'object', 'embed', 'link', 'meta', 'title', 'base', 'noscript',
      'frame', 'frameset', 'applet', 'audio', 'video', 'source', 'track',
      'canvas', 'map', 'area', 'script',
    ],
    ADD_ATTR: ['target', 'rel'],
  })
}
