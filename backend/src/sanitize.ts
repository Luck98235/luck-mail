import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

// Server-side HTML sanitising with DOMPurify (JSDOM) — contract: all HTML
// bodies stored on disk must pass through this first. DOMPurify's defaults
// already strip <script>, event handler attributes and javascript: URLs;
// we additionally forbid risky tags and remove tracking-pixel images
// (0/1-pixel size or hidden via display:none / visibility:hidden).
//
// 远程图片策略（Audit #9 L19f，明确写出）：只删 0/1 尺寸与隐藏样式的
// 像素钩子，其他远程图片照常加载——防追踪不彻底（唯一图片 URL 本身就可做追踪
// 标识），这不是安全边界。安全边界是：脚本/事件属性/javascript: 已剥离，
// 且前端在沙盒 iframe（srcdoc）里渲染洗净后的 HTML；如需彻底防追踪，
// 应由前端代理/拦截远程图片加载，不在本函数里把全部远程图片一刀切
// （会误伤正常邮件配图）。
const window = new JSDOM('').window;
const DOMPurify = createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);

DOMPurify.addHook('afterSanitizeAttributes', (node: Element) => {
  if (node.tagName === 'IMG') {
    const img = node as HTMLImageElement;
    const w = (img.getAttribute('width') || '').trim();
    const h = (img.getAttribute('height') || '').trim();
    const style = (img.getAttribute('style') || '').toLowerCase();
    // Audit #12 L1：与前端 utils/sanitize.ts 对齐（旧版后端钩子与前端
    // 不一致）：补 opacity:0 检查；宽/高样式按声明匹配（以 ; 或串首
    // 开头），避免 min-width:0 / max-width:1px 这类声明里的子串误伤——
    // 带 min-width:0;min-height:0 的正常图片旧版会在入库消毒时被误删。
    // visibility 保留 collapse（比前端多一种，后端旧行为，不收窄）。
    // Audit #16 LOW-3：小数零的写法也要拦——opacity:.0（小数点前无 0）、
    // width:1.0px / height:1.0px 是合法 CSS，旧正则只认 0 与 1px 字面，
    // 这两种写法的 1×1 像素会躲过钩子。
    // 审计 #16 跟进（后端修复员留档的同类残留）：0 尺寸的 0.0px 写法
    // 同样是合法 CSS 零值，旧正则只认 0/0px，一并放宽。
    const isPixel =
      (w === '1' && h === '1')
      || (/(^|;)\s*width\s*:\s*1(\.0+)?px/.test(style) && /(^|;)\s*height\s*:\s*1(\.0+)?px/.test(style))
      || w === '0' || h === '0'
      || /(^|;)\s*width\s*:\s*0(\.0+)?(px)?\s*(;|$)/.test(style) || /(^|;)\s*height\s*:\s*0(\.0+)?(px)?\s*(;|$)/.test(style)
      || /(^|;)\s*display\s*:\s*none\s*(;|$)/.test(style)
      || /(^|;)\s*visibility\s*:\s*(hidden|collapse)\s*(;|$)/.test(style)
      || /(^|;)\s*opacity\s*:\s*\.?0+(\.0+)?\s*(;|$)/.test(style);
    if (isPixel) node.remove();
  }
  // Audit #9 L19f：target="_blank" 的链接强制加 rel="noopener noreferrer"，
  // 防反向 Tabnabbing（旧版 ADD_ATTR 只允许 target，不强制 rel；
  // 是否生效还取决于前端沙盒 iframe 的 sandbox 配置，这里是服务端兜底）。
  if (node.tagName === 'A') {
    const a = node as HTMLAnchorElement;
    if ((a.getAttribute('target') || '').toLowerCase() === '_blank') {
      a.setAttribute('rel', 'noopener noreferrer');
    }
  }
});

export function sanitizeBodyHtml(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: [
      'style', 'form', 'input', 'button', 'select', 'textarea', 'iframe',
      'object', 'embed', 'link', 'meta', 'title', 'base', 'noscript',
      'frame', 'frameset', 'applet', 'audio', 'video', 'source', 'track',
      'canvas', 'map', 'area', 'script',
    ],
    ADD_ATTR: ['target', 'rel'],
  });
}
