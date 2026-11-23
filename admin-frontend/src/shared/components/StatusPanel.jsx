import { useEffect, useRef } from "react";
export default function StatusPanel({
  title,
  children,
  action,
  label = "Try again",
  busy = false,
}) {
  const heading = useRef(null);
  useEffect(() => {
    heading.current?.focus();
  }, [title]);
  return (
    <main id="main" className="status-page">
      <div className="wordmark">
        RIO <span>staff</span>
      </div>
      <section className="panel">
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <div role={busy ? "status" : "alert"}>{children}</div>
        {action && (
          <button onClick={action} disabled={busy}>
            {label}
          </button>
        )}
      </section>
    </main>
  );
}
