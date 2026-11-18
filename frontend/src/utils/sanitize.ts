// 正文 HTML 第二遍消毒（审计 #10 前端 H1-安全）：后端入库时已用同配置消过一遍，
// 前端在进沙盒 iframe 前再消一遍——allow-same-origin 下消毒是唯一防线，
// 两遍同配置，任一处回归都还有另一层挡着。配置与 backend/src/sanitize.ts
// 保持一致（FORBID_TAGS + ADD_ATTR + 1x1 像素钩子 + 链接 rel 兜底），
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
    const style = img.getAttribute('style') || ''
    const is1x1 = (w === '1' && h === '1')
      || (/width\s*:\s*1px/i.test(style) && /height\s*:\s*1px/i.test(style))
    if (is1x1) node.remove()
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
