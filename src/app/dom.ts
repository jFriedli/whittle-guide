/** Minimal DOM helpers — keeps the UI framework-free and small. */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string | null | undefined)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === 'class') node.className = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c == null) continue;
    node.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return node;
}

export function clear(node: Element) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export function fmtMm(mm: number, units: 'mm' | 'cm' = 'mm'): string {
  if (units === 'cm') return `${(mm / 10).toFixed(2)} cm`;
  return `${mm.toFixed(mm < 10 ? 1 : 0)} mm`;
}

export function download(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function toast(message: string, kind: 'info' | 'error' = 'info') {
  const t = el('div', { class: `toast toast--${kind}` }, [message]);
  document.body.append(t);
  requestAnimationFrame(() => t.classList.add('toast--in'));
  setTimeout(() => {
    t.classList.remove('toast--in');
    setTimeout(() => t.remove(), 300);
  }, kind === 'error' ? 6000 : 3200);
}
