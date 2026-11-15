/** Tiny DOM helpers – the UI is plain DOM over the WebGL canvas, no framework. */
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, any>;

export function h(tag: string, attrs?: Attrs | null, ...children: Child[]): HTMLElement {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'disabled' || k === 'checked' || k === 'value') (el as any)[k] = v;
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}
function append(el: Node, c: Child): void {
  if (c === null || c === undefined || c === false) return;
  if (Array.isArray(c)) { for (const x of c) append(el, x); return; }
  el.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
}
/** Appends children, skipping null / false (unlike the native Element.append). */
export function add(el: Element, ...children: Child[]): void {
  append(el, children);
}
export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}
export function setText(el: Element | null, text: string | number): void {
  const s = String(text);
  if (el && el.textContent !== s) el.textContent = s;
}

/** Button with press feedback hook (sound / haptics are attached globally by the app). */
export function btn(label: Child, onClick: (e: Event) => void, cls = '', attrs: Attrs = {}): HTMLButtonElement {
  return h(`button.btn${cls ? '.' + cls.split(' ').join('.') : ''}`, { type: 'button', onclick: onClick, ...attrs }, label) as HTMLButtonElement;
}

export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a < 10000) return String(Math.round(n));
  const units = ['K', 'M', 'B', 'T', 'Qa'];
  let u = -1, v = a;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  return (n < 0 ? '-' : '') + (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2)) + units[u];
}
export function fmtStat(n: number): string {
  if (n >= 1000) return fmtNum(n);
  return n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2).replace(/0$/, '');
}
export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}
