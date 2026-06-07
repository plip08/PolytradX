'use client';

import { useState } from 'react';
import * as Toast from '@radix-ui/react-toast';
import { useBotStore } from '../store/botStore';
import type { Toast as ToastType } from '../store/botStore';
import { clsx } from 'clsx';

const TYPE_STYLES: Record<
  ToastType['type'],
  { border: string; icon: string; iconColor: string; titleColor: string }
> = {
  error:   { border: 'border-red-500/60',    icon: '✕', iconColor: 'text-red-400',    titleColor: 'text-red-300'    },
  success: { border: 'border-green-500/60',  icon: '✓', iconColor: 'text-green-400',  titleColor: 'text-green-300'  },
  warning: { border: 'border-yellow-500/60', icon: '!', iconColor: 'text-yellow-400', titleColor: 'text-yellow-300' },
  info:    { border: 'border-sky-500/60',    icon: 'i', iconColor: 'text-sky-400',    titleColor: 'text-sky-300'    },
};

function ToastItem({
  toast,
  onRemove,
}: {
  toast: ToastType;
  onRemove: (id: string) => void;
}): React.ReactElement {
  const [open, setOpen] = useState(true);
  const cfg = TYPE_STYLES[toast.type];

  return (
    <Toast.Root
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setTimeout(() => onRemove(toast.id), 250);
      }}
      duration={toast.duration ?? 4500}
      className={clsx(
        'flex items-start gap-3 p-4 rounded-xl border bg-slate-900 shadow-2xl',
        'transition-all duration-200',
        open ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4',
        cfg.border,
      )}
    >
      <span className={clsx('text-sm font-bold mt-0.5 shrink-0 w-4 text-center', cfg.iconColor)}>
        {cfg.icon}
      </span>

      <div className="flex-1 min-w-0">
        <Toast.Title className={clsx('text-sm font-semibold leading-tight', cfg.titleColor)}>
          {toast.title}
        </Toast.Title>
        {toast.description && (
          <Toast.Description className="text-xs text-slate-400 mt-1 leading-relaxed">
            {toast.description}
          </Toast.Description>
        )}
      </div>

      <Toast.Close
        className="text-slate-600 hover:text-slate-300 text-xl leading-none transition-colors shrink-0 ml-1"
        aria-label="Close"
      >
        ×
      </Toast.Close>
    </Toast.Root>
  );
}

export function Toaster(): React.ReactElement {
  const toasts = useBotStore((s) => s.toasts);
  const removeToast = useBotStore((s) => s.removeToast);

  return (
    <Toast.Provider swipeDirection="right">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
      ))}
      <Toast.Viewport className="fixed bottom-4 right-4 flex flex-col gap-2 z-[200] w-[380px] max-w-[calc(100vw-2rem)] outline-none" />
    </Toast.Provider>
  );
}
