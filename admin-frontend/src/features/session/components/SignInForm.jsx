import { useEffect, useRef, useState } from "react";
import { useSession } from "../hooks/useSession.js";
import Icon from "../../../shared/components/Icon.jsx";

export default function SignInForm() {
  const { model, notice } = useSession();
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [unknown, setUnknown] = useState(false),
    [retryUntil, setRetryUntil] = useState(0),
    [now, setNow] = useState(() => Date.now());
  const working = useRef(false);
  const emailField = useRef(null),
    passwordField = useRef(null),
    mounted = useRef(true),
    heading = useRef(null);
  useEffect(() => {
    mounted.current = true;
    heading.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!retryUntil) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [retryUntil]);
  const remaining = Math.max(0, Math.ceil((retryUntil - now) / 1000));
  async function submit(event) {
    event.preventDefault();
    if (working.current || remaining) return;
    if (
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ||
      email.length > 254
    ) {
      setError("Enter a valid email address.");
      emailField.current?.focus();
      return;
    }
    if (!password) {
      setError("Enter your password.");
      passwordField.current?.focus();
      return;
    }
    working.current = true;
    setBusy(true);
    setError("");
    setUnknown(false);
    const entered = password;
    setPassword("");
    try {
      await model.signIn(email.trim(), entered);
    } catch (failure) {
      if (!mounted.current || failure.name === "AbortError") return;
      if (failure.status === 401) setError("Email or password is incorrect.");
      else if (failure.status === 429) {
        setRetryUntil(Date.now() + failure.retryAfter * 1000);
        setNow(Date.now());
        setError("Too many sign-in attempts. Please wait before trying again.");
      } else if (failure.status === 403)
        setError(
          "Sign-in is not permitted from this address. Use the approved staff website.",
        );
      else {
        setError(
          "We couldn’t confirm sign-in. Check your session before trying again.",
        );
        setUnknown(true);
      }
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <main id="main" className="sign-in-page">
      <div className="sign-in-brand">
        <div className="wordmark">
          RIO <span>staff</span>
        </div>
        <p>Cinema, behind the scenes.</p>
        <div className="brand-line" aria-hidden="true" />
        <p className="brand-note">
          The right access.
          <br />
          For a great experience.
        </p>
      </div>
      <section className="panel sign-in-panel" aria-labelledby="sign-in-title">
        <p className="eyebrow">
          <Icon name="lock" /> Staff workspace
        </p>
        <h1 id="sign-in-title" ref={heading} tabIndex={-1}>
          Sign in to RIO
        </h1>
        <p className="intro">Use your staff account to continue.</p>
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <form onSubmit={submit} noValidate>
          <label htmlFor="email">Email address</label>
          <input
            ref={emailField}
            id="email"
            type="email"
            autoComplete="username"
            maxLength={254}
            required
            disabled={busy}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={error === "Enter a valid email address."}
            aria-describedby={error ? "sign-in-error" : undefined}
          />
          <label htmlFor="password">Password</label>
          <input
            ref={passwordField}
            id="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={256}
            disabled={busy}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={error === "Enter your password."}
            aria-describedby={error ? "sign-in-error" : undefined}
          />
          {error && (
            <p id="sign-in-error" role="alert" className="error">
              {error}
            </p>
          )}
          {remaining > 0 && (
            <p className="hint">
              Try again in {Math.ceil(remaining / 60)}{" "}
              {remaining > 60 ? "minutes" : "minute"}.
            </p>
          )}
          <button
            className="primary"
            type="submit"
            disabled={busy || remaining > 0}
          >
            {busy ? "Signing in…" : "Sign in"}
          </button>
          {unknown && (
            <button
              type="button"
              className="secondary"
              onClick={() => model.check()}
            >
              Check sign-in status
            </button>
          )}
        </form>
        <p className="hint">Need access? Contact your administrator.</p>
      </section>
      <p className="sign-in-footer">Oulu · Tampere</p>
    </main>
  );
}
