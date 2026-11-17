import { JSDOM } from 'jsdom';
import createDOMPurify from 'dompurify';

// Server-side HTML sanitising with DOMPurify (JSDOM) — contract: all HTML
// bodies stored on disk must pass through this first. DOMPurify's defaults
// already strip <script>, event handler attributes and javascript: URLs;
// we additionally forbid risky tags and remove 1x1 tracking pixels.
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
