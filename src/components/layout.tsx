import type { ReactNode } from "react";

export function Screen({
  title,
  subtitle,
  actions,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="screen-content mx-auto px-7 py-6 flex flex-col gap-5" style={{ maxWidth: 1180 }}>
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <h1 className="text-[21px] font-bold tracking-tight leading-tight">{title}</h1>
            {subtitle ? <p className="muted text-[13.5px] mt-1">{subtitle}</p> : null}
          </div>
          {actions ? <div className="flex items-center gap-2 shrink-0">{actions}</div> : null}
        </header>
        {children}
      </div>
    </div>
  );
}

export function TwoColumn({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="two-col">
      <div className="col-main flex flex-col gap-4">{main}</div>
      <div className="col-side flex flex-col gap-4">{side}</div>
    </div>
  );
}

export function OptionCard({ title, children, className = "" }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={`card p-4 flex flex-col gap-3.5 ${className}`}>
      {title ? <h3 className="text-[13px] font-bold uppercase tracking-wider muted">{title}</h3> : null}
      {children}
    </div>
  );
}
