import type { ReactNode } from 'react';

// Small, style-guide-aligned building blocks used across pages.

export function Spinner() {
  return (
    <div className="state">
      <span className="spinner" aria-label="Loading" />
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div className="state">
      <div className="state-title error-text">Something went wrong</div>
      <div>{message}</div>
    </div>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="card">
      <div className="state">
        <div className="state-title">{title}</div>
        <div className="reading-copy">{body}</div>
      </div>
    </div>
  );
}

export function SectionHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="section-head">
      <h2>{title}</h2>
      <div className="spacer" />
      {children}
    </div>
  );
}

type StatusKind =
  | 'ok'
  | 'info'
  | 'warn'
  | 'pending'
  | 'urgent'
  | 'error'
  | 'neutral';

const RUN_STATUS: Record<string, StatusKind> = {
  succeeded: 'ok',
  running: 'info',
  queued: 'pending',
  failed: 'error',
  cancelled: 'neutral',
  interrupted: 'urgent',
  connected: 'ok',
  disconnected: 'neutral',
};

export function StatusPill({ status }: { status: string }) {
  const kind = RUN_STATUS[status] ?? 'neutral';
  return <span className={`pill ${kind}`}>{status}</span>;
}

export function PolicyPill({ policy }: { policy: string }) {
  return <span className={`pill policy-${policy}`}>{policy}</span>;
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <h3>{title}</h3>
        {children}
      </div>
    </div>
  );
}
