'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import * as Icon from '@/components/icons';

/**
 * Modal dialog on the native <dialog> element: focus stays inside, Escape and the backdrop close it, and the
 * page behind is inert. Full-screen sheet on phones, centred card on larger screens.
 */
export function Dialog({ open, onClose, title, children, footer, wide = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref} onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={title}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className={`m-0 h-[100dvh] max-h-none w-full max-w-none bg-elevated p-0 text-ink backdrop:bg-black/60 sm:m-auto sm:h-auto sm:max-h-[min(88dvh,820px)] sm:rounded-2xl sm:shadow-[var(--shadow)] ${wide ? 'sm:w-[640px]' : 'sm:w-[440px]'}`}
    >
      {open && (
        <div className="flex h-full max-h-[inherit] flex-col">
          <div className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
            <h2 className="text-[18px] font-semibold">{title}</h2>
            <button type="button" onClick={onClose} aria-label="Close" className="-mr-2 grid h-10 w-10 place-items-center rounded-full hover:bg-surface"><Icon.Close size={22} /></button>
          </div>
          <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-4">{children}</div>
          {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}

export const buttonClass = {
  primary: 'inline-flex h-9 items-center justify-center gap-2 rounded-full bg-brand px-4 text-[14px] font-semibold text-on-brand hover:bg-brand-strong disabled:opacity-50',
  quiet: 'inline-flex h-9 items-center justify-center gap-2 rounded-full px-4 text-[14px] font-medium hover:bg-surface disabled:opacity-50',
  soft: 'inline-flex h-9 items-center justify-center gap-2 rounded-full bg-surface px-4 text-[14px] font-medium hover:bg-surface-hover disabled:opacity-50',
};
export const inputClass = 'w-full rounded-lg border border-line bg-bg px-3 py-2 text-[14px] outline-none placeholder:text-faint focus:border-brand';
