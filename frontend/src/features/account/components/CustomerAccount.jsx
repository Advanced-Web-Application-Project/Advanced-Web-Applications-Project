import { useEffect, useRef, useState } from "react";
import { useCustomerSession } from "../hooks/useCustomerSession.js";

export default function CustomerAccount() {
  const { status, session, model } = useCustomerSession();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [formMode, setFormMode] = useState("login");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [unknown, setUnknown] = useState(false);
  const emailField = useRef(null);
  const passwordField = useRef(null);
  const confirmPasswordField = useRef(null);
  const isMounted = useRef(true);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (open && status === "anonymous") emailField.current?.focus();
  }, [open, status]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const invalidEmail =
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) || email.length > 254;
    if (invalidEmail) {
      setError("Enter a valid email address.");
      emailField.current?.focus();
      return;
    }
    if (!password) {
      setError("Enter your password.");
      passwordField.current?.focus();
      return;
    }
    if (
      formMode === "register" &&
      (Array.from(password).length < 15 || Array.from(password).length > 128)
    ) {
      setError("Use a password of 15 to 128 characters.");
      passwordField.current?.focus();
      return;
    }
    if (formMode === "register" && password !== confirmPassword) {
      setError("Passwords do not match.");
      confirmPasswordField.current?.focus();
      return;
    }
    setBusy(true);
    setError("");
    setUnknown(false);
    const entered = password;
    setPassword("");
    setConfirmPassword("");
    try {
      if (formMode === "register") await model.register(email.trim(), entered);
      else await model.signIn(email.trim(), entered);
      if (isMounted.current) {
        setOpen(false);
        setFormMode("login");
      }
    } catch (failure) {
      if (!isMounted.current || failure.name === "AbortError") return;
      setError(
        failure.status === 401
          ? "Email or password is incorrect."
          : failure.status === 400
            ? "Check the email and password requirements."
            : failure.status === 409
              ? "An account with this email already exists. Sign in instead."
              : failure.status === 429
                ? "Too many attempts. Please wait before trying again."
                : failure.status === 403
                  ? "Account access is not permitted from this address."
                  : `We couldn’t confirm ${formMode === "register" ? "registration" : "sign-in"}. Check your account status before retrying.`,
      );
      setUnknown(!failure.status || failure.status >= 500);
    } finally {
      if (isMounted.current) setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError("");
    try {
      await model.signOut();
      if (isMounted.current) {
        setOpen(false);
        setFormMode("login");
      }
    } catch {
      if (isMounted.current)
        setError("We couldn’t confirm sign-out. Please try again.");
    } finally {
      if (isMounted.current) setBusy(false);
    }
  }

  function toggleFormMode() {
    setFormMode((mode) => (mode === "login" ? "register" : "login"));
    setError("");
    setUnknown(false);
    setPassword("");
    setConfirmPassword("");
  }

  return (
    <div className="customer-account">
      {status === "authenticated" || status === "signingOut" ? (
        <button
          className="account-button"
          type="button"
          onClick={signOut}
          disabled={busy || status === "signingOut"}
        >
          {busy || status === "signingOut" ? "Signing out…" : "Sign out"}
        </button>
      ) : (
        <button
          className="account-button"
          type="button"
          aria-expanded={open}
          aria-controls="customer-account-panel"
          onClick={() => setOpen((value) => !value)}
        >
          Customer sign in
        </button>
      )}
      {open && status !== "authenticated" && (
        <section
          className="account-panel"
          id="customer-account-panel"
          aria-labelledby="customer-account-title"
        >
          <h2 id="customer-account-title">Your RIO account</h2>
          {status === "checking" ? (
            <p role="status">Checking your account…</p>
          ) : status === "unavailable" ? (
            <>
              <p role="status">
                Account sign-in isn’t available right now. You can continue as a
                guest.
              </p>
              <button
                type="button"
                className="account-retry"
                onClick={() => model.check()}
              >
                Check again
              </button>
            </>
          ) : status === "error" ? (
            <>
              <p role="alert">
                We couldn’t verify your account. You can continue as a guest.
              </p>
              <button
                type="button"
                className="account-retry"
                onClick={() => model.check()}
              >
                Check again
              </button>
            </>
          ) : (
            <>
              <p>
                {formMode === "register"
                  ? "Create an account with your email address and a password."
                  : "Sign in with your customer account, or continue as a guest."}
              </p>
              <form onSubmit={submit} noValidate>
                <label htmlFor="customer-email">Email address</label>
                <input
                  id="customer-email"
                  ref={emailField}
                  type="email"
                  autoComplete={formMode === "register" ? "email" : "username"}
                  maxLength={254}
                  required
                  disabled={busy}
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  aria-invalid={
                    error === "Enter a valid email address." || undefined
                  }
                  aria-describedby={
                    error ? "customer-sign-in-error" : undefined
                  }
                />
                <label htmlFor="customer-password">
                  {formMode === "register"
                    ? "Password (15 to 128 characters)"
                    : "Password"}
                </label>
                <input
                  id="customer-password"
                  ref={passwordField}
                  type="password"
                  autoComplete={
                    formMode === "register"
                      ? "new-password"
                      : "current-password"
                  }
                  maxLength={256}
                  required
                  disabled={busy}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  aria-invalid={
                    [
                      "Enter your password.",
                      "Use a password of 15 to 128 characters.",
                    ].includes(error) || undefined
                  }
                  aria-describedby={
                    error ? "customer-sign-in-error" : undefined
                  }
                />
                {formMode === "register" && (
                  <>
                    <label htmlFor="customer-password-confirm">
                      Confirm password
                    </label>
                    <input
                      id="customer-password-confirm"
                      ref={confirmPasswordField}
                      type="password"
                      autoComplete="new-password"
                      maxLength={256}
                      required
                      disabled={busy}
                      value={confirmPassword}
                      onChange={(event) =>
                        setConfirmPassword(event.target.value)
                      }
                      aria-invalid={
                        error === "Passwords do not match." || undefined
                      }
                      aria-describedby={
                        error ? "customer-sign-in-error" : undefined
                      }
                    />
                  </>
                )}
                {error && (
                  <p
                    className="account-error"
                    id="customer-sign-in-error"
                    role="alert"
                  >
                    {error}
                  </p>
                )}
                <button
                  className="account-submit"
                  type="submit"
                  disabled={busy}
                >
                  {busy
                    ? formMode === "register"
                      ? "Creating account…"
                      : "Signing in…"
                    : formMode === "register"
                      ? "Create account"
                      : "Sign in"}
                </button>
                {unknown && (
                  <button
                    className="account-retry"
                    type="button"
                    onClick={() => model.check()}
                  >
                    {formMode === "register"
                      ? "Check registration status"
                      : "Check sign-in status"}
                  </button>
                )}
                <button
                  className="account-switch"
                  type="button"
                  onClick={toggleFormMode}
                  disabled={busy}
                >
                  {formMode === "register"
                    ? "Already have an account? Sign in"
                    : "Create an account"}
                </button>
              </form>
              <p className="account-note">
                {formMode === "register"
                  ? "Your account will be active immediately. Guest checkout remains available."
                  : "Guest checkout remains available. For help with an existing account, contact the cinema."}
              </p>
            </>
          )}
        </section>
      )}
      {status === "authenticated" && (
        <span className="account-status" role="status">
          Signed in as {session.user.email}
        </span>
      )}
      {status === "authenticated" && error && (
        <span className="account-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
