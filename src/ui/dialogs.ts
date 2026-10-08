// Modal dialogs, action sheets and toasts sized for touch.
import { h, icon } from './dom.ts';

export function dismissToast(): void {
  document.querySelector('.toast')?.remove();
}

function modal(content: HTMLElement, onClose: () => void): () => void {
  dismissToast();
  const backdrop = h('div', { class: 'backdrop' });
  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close();
      onClose();
    }
  };
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) {
      close();
      onClose();
    }
  });
  document.addEventListener('keydown', onKey);
  backdrop.append(content);
  document.body.append(backdrop);
  return close;
}

export function promptDialog(
  title: string,
  value = '',
  opts: { okLabel?: string; placeholder?: string; hint?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', {
      class: 'input',
      type: 'text',
      value,
      placeholder: opts.placeholder || '',
      autocapitalize: 'off',
      autocomplete: 'off',
      spellcheck: 'false',
    });
    const form = h(
      'form',
      { class: 'dialog', role: 'dialog', 'aria-label': title },
      h('h2', {}, title),
      input,
      opts.hint ? h('p', { class: 'hint' }, opts.hint) : null,
      h(
        'div',
        { class: 'dialog-buttons' },
        h('button', { type: 'button', class: 'btn', onclick: () => done(null) }, 'Cancel'),
        h('button', { type: 'submit', class: 'btn primary' }, opts.okLabel || 'OK'),
      ),
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      done(input.value.trim() || null);
    });
    const close = modal(form, () => resolve(null));
    function done(v: string | null) {
      close();
      resolve(v);
    }
    requestAnimationFrame(() => {
      input.focus();
      // Select the name part of "file.tex" so typing replaces it.
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    });
  });
}

export function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const box = h(
      'div',
      { class: 'dialog', role: 'alertdialog', 'aria-label': title },
      h('h2', {}, title),
      h('p', {}, message),
      h(
        'div',
        { class: 'dialog-buttons' },
        h('button', { type: 'button', class: 'btn', onclick: () => done(false) }, 'Cancel'),
        h('button', { type: 'button', class: 'btn ' + (danger ? 'danger' : 'primary'), onclick: () => done(true) }, okLabel),
      ),
    );
    const close = modal(box, () => resolve(false));
    function done(v: boolean) {
      close();
      resolve(v);
    }
  });
}

export function infoDialog(title: string, body: HTMLElement | string): void {
  const box = h(
    'div',
    { class: 'dialog', role: 'dialog', 'aria-label': title },
    h('h2', {}, title),
    typeof body === 'string' ? h('p', {}, body) : body,
    h('div', { class: 'dialog-buttons' }, h('button', { type: 'button', class: 'btn primary', onclick: () => close() }, 'Close')),
  );
  const close = modal(box, () => {});
}

export interface SheetAction {
  label: string;
  icon?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

/** Action sheet (bottom sheet on phones, popover-ish card on desktop). */
export function actionSheet(title: string | null, actions: SheetAction[]): void {
  const list = h(
    'div',
    { class: 'sheet', role: 'menu' },
    title ? h('div', { class: 'sheet-title' }, title) : null,
    actions.map((a) =>
      h(
        'button',
        {
          type: 'button',
          role: 'menuitem',
          class: 'sheet-item' + (a.danger ? ' danger' : ''),
          disabled: a.disabled,
          onclick: () => {
            close();
            void a.run();
          },
        },
        a.icon ? icon(a.icon) : null,
        a.label,
      ),
    ),
    h('button', { type: 'button', class: 'sheet-item cancel', onclick: () => close() }, 'Cancel'),
  );
  const close = modal(list, () => {});
}

let toastTimer: number | undefined;
export function toast(message: string, action?: { label: string; run: () => void }, ms = 3500): void {
  document.querySelector('.toast')?.remove();
  window.clearTimeout(toastTimer);
  const el = h(
    'div',
    { class: 'toast', role: 'status' },
    h('span', {}, message),
    action
      ? h(
          'button',
          {
            type: 'button',
            class: 'toast-action',
            onclick: () => {
              el.remove();
              action.run();
            },
          },
          action.label,
        )
      : null,
  );
  document.body.append(el);
  toastTimer = window.setTimeout(() => el.remove(), action ? ms * 1.5 : ms);
}
