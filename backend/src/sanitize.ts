import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

// Server-side HTML sanitising with DOMPurify (JSDOM) — contract: all HTML
// bodies stored on disk must pass through this first. DOMPurify's defaults
// already strip <script>, event handler attributes and javascript: URLs;
// we additionally forbid risky tags and remove 1x1 tracking pixels.
//
// 远程图片策略（Audit #9 L19f，明确写出）：只删显式 1x1 像素钩子，
// 其他远程图片照常加载——防追踪不彻底（唯一图片 URL 本身就可做追踪
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
    const style = img.getAttribute('style') || '';
    const is1x1 = (w === '1' && h === '1')
      || (/width\s*:\s*1px/i.test(style) && /height\s*:\s*1px/i.test(style));
    if (is1x1) node.remove();
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
