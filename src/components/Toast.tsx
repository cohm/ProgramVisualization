'use client';

import React, { useEffect } from 'react';
import kthColors from '@/data/kth-colors.json';
import { tr, type Lang } from '@/lib/translations';

export interface ToastMessage {
  title: string;
  detail?: string;
}

interface Props {
  language: Lang;
  toast: ToastMessage | null;
  onClose: () => void;
  // Optional auto-dismiss timeout (ms). Default 6 s; pass 0 to disable.
  autoDismissMs?: number;
}

// Small fixed-position banner at the bottom-right. Click to dismiss; auto-
// dismisses after 6 s by default. Used for non-blocking failure feedback
// (PDF export errors, cosmetics-load failures) — replaces alert() and
// console-only warnings.
export default function Toast({ language, toast, onClose, autoDismissMs = 6000 }: Props) {
  useEffect(() => {
    if (!toast || !autoDismissMs) return;
    const id = window.setTimeout(onClose, autoDismissMs);
    return () => window.clearTimeout(id);
  }, [toast, onClose, autoDismissMs]);

  if (!toast) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 16,
        right: 16,
        maxWidth: 380,
        padding: '10px 14px',
        background: kthColors.KthMarine?.HEX || '#000061',
        color: '#fff',
        borderRadius: 6,
        boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
        zIndex: 2000,
        fontSize: 13,
        cursor: 'pointer',
      }}
      onClick={onClose}
      title={tr[language].closeToast}
    >
      <div style={{ fontWeight: 600, marginBottom: toast.detail ? 4 : 0 }}>
        {toast.title}
      </div>
      {toast.detail && (
        <div style={{ fontSize: 11, opacity: 0.85, wordBreak: 'break-word' }}>
          {toast.detail}
        </div>
      )}
    </div>
  );
}
