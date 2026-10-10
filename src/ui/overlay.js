// Modal + popover + toast primitives.

let openModalCount = 0;
export const modalOpen = () => openModalCount > 0;

export function openModal({ title, className = '', onClose } = {}) {
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `<div class="modal ${className}" role="dialog" aria-modal="true">
    <div class="modal-head"><h3></h3><button class="icon-btn" data-close aria-label="close">✕</button></div>
    <div class="modal-body"></div>
  </div>`;
  backdrop.querySelector('h3').innerHTML = title;
  const modal = backdrop.querySelector('.modal');
  const body = backdrop.querySelector('.modal-body');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    openModalCount--;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    onClose?.();
  };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('pointerdown', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('[data-close]').addEventListener('click', close);
  document.body.append(backdrop);
  openModalCount++;
  return { backdrop, modal, body, close, isClosed: () => closed };
}

export function openPopover(anchor, { className = '', width = 380 } = {}) {
  document.querySelectorAll('.popover').forEach(p => p._close?.());
  const pop = document.createElement('div');
  pop.className = `popover ${className}`;
  pop.style.width = `${Math.min(width, innerWidth - 24)}px`;
  document.body.append(pop);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    let left = r.right + 10;
    if (left + w > innerWidth - 12) left = r.left - w - 10;
    if (left < 12) left = Math.min(Math.max(12, r.left), innerWidth - w - 12);
    const h = pop.offsetHeight;
    let top = Math.min(Math.max(12, r.top - 40), innerHeight - h - 12);
    pop.style.left = `${left}px`;
    pop.style.top = `${Math.max(12, top)}px`;
  };
  const onDown = e => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const close = () => {
    pop.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    removeEventListener('resize', place);
  };
  pop._close = close;
  setTimeout(() => document.addEventListener('pointerdown', onDown, true), 0);
  document.addEventListener('keydown', onKey);
  addEventListener('resize', place);
  return { pop, place, close };
}

let toastTimer = 0;
export function toast(msg, ms = 1800) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}
