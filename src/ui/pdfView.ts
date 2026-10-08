// PDF preview built on pdf.js. Pages render lazily near the viewport and are
// released when far away (iOS limits total canvas memory). A recompile keeps the
// reading position: we remember "page N, x% down" and restore it on the new PDF
// before swapping it in, so the view does not jump.
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { h, icon } from './dom.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const MAX_CANVAS_PIXELS = 12_000_000;
const GAP = 12;

interface PageSlot {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  widthPt: number;
  heightPt: number;
  rendered: number; // scale rendered at, 0 = not rendered
  task: { cancel(): void } | null;
}

export class PdfView {
  readonly root: HTMLElement;
  private scroller: HTMLDivElement;
  private pagesEl: HTMLDivElement;
  private info: HTMLSpanElement;
  private zoomLabel: HTMLSpanElement;
  private empty: HTMLElement;
  private doc: PDFDocumentProxy | null = null;
  private loading: PDFDocumentLoadingTask | null = null;
  private slots: PageSlot[] = [];
  private zoom = 1; // relative to fit-width
  private observer: IntersectionObserver;
  private generation = 0;
  pageCount = 0;

  constructor(actions: { download: () => void; share: (() => void) | null }) {
    this.info = h('span', { class: 'pdf-info', 'data-testid': 'pdf-pages' }, '');
    this.zoomLabel = h('span', { class: 'zoom-label' }, 'Fit');
    const toolbar = h(
      'div',
      { class: 'pane-head pdf-toolbar' },
      h('button', { type: 'button', class: 'icon-btn', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.setZoom(this.zoom / 1.25) }, icon('minus')),
      this.zoomLabel,
      h('button', { type: 'button', class: 'icon-btn', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.setZoom(this.zoom * 1.25) }, icon('plus')),
      h('button', { type: 'button', class: 'icon-btn', title: 'Fit width', 'aria-label': 'Fit width', onclick: () => this.setZoom(1) }, icon('fit')),
      this.info,
      h('span', { class: 'spacer' }),
      actions.share
        ? h('button', { type: 'button', class: 'icon-btn', title: 'Share PDF', 'aria-label': 'Share PDF', onclick: actions.share }, icon('share'))
        : null,
      h('button', { type: 'button', class: 'icon-btn', title: 'Download PDF', 'aria-label': 'Download PDF', onclick: actions.download }, icon('download')),
    );
    this.empty = h('div', { class: 'empty' }, h('p', {}, 'No PDF yet.'), h('p', { class: 'hint' }, 'Tap Compile to build your document.'));
    this.pagesEl = h('div', { class: 'pdf-pages' });
    this.scroller = h('div', { class: 'pdf-scroller', 'data-testid': 'pdf-scroller' }, this.empty, this.pagesEl);
    this.root = h('div', { class: 'pdf-view' }, toolbar, this.scroller);

    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: this.scroller,
      rootMargin: '150% 0px',
    });
    let resizeTimer: number | undefined;
    new ResizeObserver(() => {
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => this.relayout(), 150);
    }).observe(this.scroller);
    this.setupPinch();
  }

  private fitScale(widthPt: number): number {
    const avail = Math.max(100, this.scroller.clientWidth - 2 * GAP);
    return avail / widthPt;
  }

  private scale(): number {
    const maxW = Math.max(...this.slots.map((s) => s.widthPt), 1);
    return this.fitScale(maxW) * this.zoom;
  }

  /** Remember the reading position as page index + fraction within the page. */
  private position(): { page: number; frac: number; x: number } {
    const top = this.scroller.scrollTop;
    for (let i = 0; i < this.slots.length; i++) {
      const el = this.slots[i].el;
      if (el.offsetTop + el.offsetHeight > top) {
        return {
          page: i,
          frac: Math.max(0, (top - el.offsetTop) / el.offsetHeight),
          x: this.scroller.scrollWidth > this.scroller.clientWidth ? this.scroller.scrollLeft / this.scroller.scrollWidth : 0,
        };
      }
    }
    return { page: 0, frac: 0, x: 0 };
  }

  private restore(pos: { page: number; frac: number; x: number }) {
    const slot = this.slots[Math.min(pos.page, this.slots.length - 1)];
    if (!slot) return;
    this.scroller.scrollTop = slot.el.offsetTop + pos.frac * slot.el.offsetHeight;
    this.scroller.scrollLeft = pos.x * this.scroller.scrollWidth;
  }

  clear() {
    this.generation++;
    for (const s of this.slots) s.task?.cancel();
    this.slots = [];
    this.pagesEl.replaceChildren();
    void this.loading?.destroy();
    this.loading = null;
    this.doc = null;
    this.pageCount = 0;
    this.info.textContent = '';
    this.empty.hidden = false;
  }

  async show(data: Uint8Array): Promise<void> {
    const gen = ++this.generation;
    const pos = this.slots.length ? this.position() : { page: 0, frac: 0, x: 0 };
    const task = pdfjs.getDocument({ data: data.slice() });
    const doc = await task.promise;
    if (gen !== this.generation) {
      void task.destroy();
      return;
    }
    const pages: PDFPageProxy[] = [];
    for (let i = 1; i <= doc.numPages; i++) pages.push(await doc.getPage(i));
    if (gen !== this.generation) {
      void task.destroy();
      return;
    }

    const slots: PageSlot[] = pages.map((p, i) => {
      const vp = p.getViewport({ scale: 1 });
      const el = h('div', { class: 'pdf-page', 'data-page': String(i + 1) });
      return { el, canvas: null, widthPt: vp.width, heightPt: vp.height, rendered: 0, task: null };
    });
    const oldSlots = this.slots;
    const oldTask = this.loading;
    for (const s of oldSlots) {
      this.observer.unobserve(s.el);
      s.task?.cancel();
    }
    this.doc = doc;
    this.loading = task;
    this.slots = slots;
    this.pageCount = doc.numPages;

    // Lay the new pages out off-screen, render what will be visible at the
    // remembered position, then swap: no blank flash, no scroll jump.
    const fresh = h('div', { class: 'pdf-pages staging' });
    fresh.append(...slots.map((s) => s.el));
    this.scroller.append(fresh);
    this.layout();
    const anchor = slots[Math.min(pos.page, slots.length - 1)];
    const top = anchor.el.offsetTop + pos.frac * anchor.el.offsetHeight;
    const bottom = top + this.scroller.clientHeight;
    const visible = slots.filter((s) => s.el.offsetTop < bottom && s.el.offsetTop + s.el.offsetHeight > top);
    await Promise.all(visible.map((s) => this.render(s, gen)));
    if (gen !== this.generation) {
      fresh.remove();
      return;
    }
    this.pagesEl.remove();
    fresh.classList.remove('staging');
    this.pagesEl = fresh;
    this.empty.hidden = true;
    this.scroller.scrollTop = top;
    this.scroller.scrollLeft = pos.x * this.scroller.scrollWidth;
    for (const s of slots) this.observer.observe(s.el);
    void oldTask?.destroy();
    this.info.textContent = `${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`;
  }

  private visibleSlots(): PageSlot[] {
    const top = this.scroller.scrollTop;
    const bottom = top + this.scroller.clientHeight;
    return this.slots.filter((s) => s.el.offsetTop < bottom && s.el.offsetTop + s.el.offsetHeight > top);
  }

  private layout() {
    const scale = this.scale();
    for (const s of this.slots) {
      s.el.style.width = Math.floor(s.widthPt * scale) + 'px';
      s.el.style.height = Math.floor(s.heightPt * scale) + 'px';
    }
    this.zoomLabel.textContent = Math.abs(this.zoom - 1) < 0.01 ? 'Fit' : Math.round(this.zoom * 100) + '%';
  }

  private relayout() {
    if (!this.slots.length) return;
    const pos = this.position();
    this.layout();
    this.restore(pos);
    const scale = this.scale();
    for (const s of this.visibleSlots()) if (s.rendered !== scale) void this.render(s, this.generation);
  }

  setZoom(z: number) {
    this.zoom = Math.min(4, Math.max(0.5, z));
    this.relayout();
  }

  private onIntersect(entries: IntersectionObserverEntry[]) {
    for (const e of entries) {
      const slot = this.slots.find((s) => s.el === e.target);
      if (!slot) continue;
      if (e.isIntersecting) void this.render(slot, this.generation);
      else this.release(slot);
    }
  }

  private release(slot: PageSlot) {
    slot.task?.cancel();
    slot.task = null;
    if (slot.canvas) {
      slot.canvas.width = 0;
      slot.canvas.height = 0;
      slot.canvas.remove();
      slot.canvas = null;
    }
    slot.rendered = 0;
  }

  private async render(slot: PageSlot, gen: number) {
    if (!this.doc || gen !== this.generation) return;
    const scale = this.scale();
    if (slot.rendered === scale) return;
    slot.task?.cancel();
    const index = this.slots.indexOf(slot);
    const page = await this.doc.getPage(index + 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const viewport = page.getViewport({ scale: scale * dpr });
    let ratio = 1;
    if (viewport.width * viewport.height > MAX_CANVAS_PIXELS) {
      ratio = Math.sqrt(MAX_CANVAS_PIXELS / (viewport.width * viewport.height));
    }
    const vp = page.getViewport({ scale: scale * dpr * ratio });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(vp.width);
    canvas.height = Math.floor(vp.height);
    const task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp });
    slot.task = task;
    try {
      await task.promise;
    } catch {
      return; // cancelled
    }
    if (gen !== this.generation || slot.task !== task) return;
    slot.task = null;
    slot.canvas?.remove();
    slot.canvas = canvas;
    slot.rendered = scale;
    slot.el.append(canvas);
  }

  /** Two-finger pinch zoom on the page column (the app itself does not zoom). */
  private setupPinch() {
    const pts = new Map<number, { x: number; y: number }>();
    let start = 0;
    let startZoom = 1;
    let ratio = 1;
    let origin = { x: 0, y: 0 };
    const dist = () => {
      const [a, b] = [...pts.values()];
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    this.scroller.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'touch') return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2) {
        start = dist();
        startZoom = this.zoom;
        ratio = 1;
        const [a, b] = [...pts.values()];
        const r = this.pagesEl.getBoundingClientRect();
        origin = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
        this.pagesEl.style.transformOrigin = `${origin.x}px ${origin.y}px`;
      }
    });
    this.scroller.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pts.size === 2 && start > 0) {
        ratio = Math.min(4 / startZoom, Math.max(0.5 / startZoom, dist() / start));
        this.pagesEl.style.transform = `scale(${ratio})`;
      }
    });
    const end = (e: PointerEvent) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size < 2 && start > 0) {
        start = 0;
        this.pagesEl.style.transform = '';
        if (Math.abs(ratio - 1) > 0.02) {
          // Keep the pinch centre in place after re-layout.
          const before = { x: this.scroller.scrollLeft + origin.x, y: this.scroller.scrollTop + origin.y };
          const applied = Math.min(4, Math.max(0.5, startZoom * ratio)) / this.zoom;
          this.zoom = Math.min(4, Math.max(0.5, startZoom * ratio));
          this.layout();
          this.scroller.scrollLeft = before.x * applied - origin.x;
          this.scroller.scrollTop = before.y * applied - origin.y;
          for (const s of this.visibleSlots()) void this.render(s, this.generation);
        }
      }
    };
    this.scroller.addEventListener('pointerup', end);
    this.scroller.addEventListener('pointercancel', end);
  }
}
