package local.jharness.browser;

/** Runs in a named isolated world of the current top-level frame. */
final class DomSnapshotter {
    static final String SNAPSHOT = """
            (() => {
              const candidates = document.querySelectorAll('a[href],button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=combobox],[contenteditable=true]');
              const elements = [];
              const handles = [];
              function selector(el) {
                const path = [];
                while (el && el.nodeType === 1) {
                  if (el.id) {
                    const id = '#' + CSS.escape(el.id);
                    if (document.querySelectorAll(id).length === 1) { path.unshift(id); break; }
                  }
                  const tag = CSS.escape(el.localName);
                  let index = 1;
                  for (let p = el.previousElementSibling; p; p = p.previousElementSibling)
                    if (p.localName === el.localName) index++;
                  path.unshift(tag + ':nth-of-type(' + index + ')');
                  el = el.parentElement;
                }
                return path.join(' > ');
              }
              for (const el of candidates) {
                const r = el.getBoundingClientRect(), style = getComputedStyle(el);
                if (!r.width || !r.height || r.bottom <= 0 || r.right <= 0 || r.top >= innerHeight ||
                    r.left >= innerWidth || style.visibility !== 'visible' || Number(style.opacity) === 0) continue;
                handles.push(el);
                const name = el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.innerText || el.placeholder || el.name || el.title || '';
                const sensitive = el.matches('input[type=password],input[type=file],[autocomplete=one-time-code],[autocomplete^="cc-"]');
                elements.push({ref:handles.length, tag:el.localName, type:el.type || '', role:el.getAttribute('role') || '',
                  name:name.trim().slice(0,160), value:sensitive ? '[需人工操作]' : String(el.value ?? '').slice(0,100),
                  selector:selector(el), x:Math.round((Math.max(0,r.left)+Math.min(innerWidth,r.right))/2),
                  y:Math.round((Math.max(0,r.top)+Math.min(innerHeight,r.bottom))/2)});
                if (handles.length === 120) break;
              }
              globalThis.__jhHandles = handles;
              const text = document.body?.innerText || '';
              return {url:location.href,title:document.title,width:innerWidth,height:innerHeight,
                scrollX,scrollY,scrollHeight:document.scrollingElement?.scrollHeight || 0,elements,
                text:text.slice(0,8000),truncated:text.length>8000};
            })()
            """;
    private DomSnapshotter() {}
}
