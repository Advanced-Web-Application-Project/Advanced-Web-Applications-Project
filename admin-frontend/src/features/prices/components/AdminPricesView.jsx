import { useEffect, useRef, useState } from "react";
import { useSession } from "../../session/hooks/useSession.js";
import {
  calculateDerivedChildCents,
  createPriceAdminService,
  formatCentsAsEur,
  formatTimestamp,
  parseEuroInputToCents,
} from "../services/priceAdmin.js";

function readSettings(rows) {
  if (!Array.isArray(rows)) throw new Error("Invalid settings");
  const adult = rows.find((row) => row.category === "adult");
  if (!adult && rows.length === 0) return { adult: null, version: 0 };
  const cents = adult?.amount_cents ?? adult?.amountCents;
  if (
    !Number.isInteger(cents) ||
    cents <= 0 ||
    !Number.isInteger(adult?.version) ||
    adult.version <= 0
  ) {
    throw new Error("Invalid adult settings");
  }
  return { adult: { ...adult, amount_cents: cents }, version: adult.version };
}

export default function AdminPricesView() {
  const { model } = useSession();
  const [service] = useState(() => createPriceAdminService(model));
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [adultInput, setAdultInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [needsReload, setNeedsReload] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const inputRef = useRef(null);
  const alive = useRef(false);
  const busy = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    alive.current = true;
    service
      .listPrices(controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        const next = readSettings(rows);
        setSettings(next);
        setAdultInput(
          next.adult ? (next.adult.amount_cents / 100).toFixed(2) : "",
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted && error.name !== "AbortError")
          setLoadError("Could not load price configuration. Please try again.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [service]);

  async function reload() {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    setLoadError("");
    try {
      const next = readSettings(await service.listPrices());
      if (!alive.current) return;
      setSettings(next);
      if (!settings)
        setAdultInput(
          next.adult ? (next.adult.amount_cents / 100).toFixed(2) : "",
        );
      // Preserve the draft so staff can compare it with the freshly read price.
      setNeedsReload(false);
      setSubmitError("");
      setStatusMessage(
        "Latest prices loaded. Review the current price and your draft before saving.",
      );
    } catch {
      if (alive.current)
        setLoadError("Could not load price configuration. Please try again.");
    } finally {
      busy.current = false;
      if (alive.current) setLoading(false);
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (busy.current || loading || needsReload || !settings) return;
    const parsed = parseEuroInputToCents(adultInput);
    setStatusMessage("");
    if (parsed.error) {
      setSubmitError(parsed.error);
      inputRef.current?.focus();
      return;
    }
    busy.current = true;
    setSaving(true);
    setSubmitError("");
    try {
      const result = await service.updateAdultPrice({
        amountCents: parsed.amountCents,
        expectedVersion: settings.version,
      });
      const next = readSettings(result?.updated ?? result?.prices);
      if (
        !next.adult ||
        next.adult.amount_cents !== parsed.amountCents ||
        next.version !== settings.version + 1
      )
        throw new Error("Unconfirmed save response");
      if (!alive.current) return;
      setSettings(next);
      setAdultInput((next.adult.amount_cents / 100).toFixed(2));
      setStatusMessage(
        `Saved ${formatCentsAsEur(next.adult.amount_cents)} adult / ${formatCentsAsEur(calculateDerivedChildCents(next.adult.amount_cents))} child.`,
      );
    } catch (error) {
      if (!alive.current) return;
      // Any unconfirmed outcome must be read back before another explicit write.
      setNeedsReload(true);
      setSubmitError(
        error?.status === 409
          ? "Price settings changed while you were editing. Reload the latest prices before saving again."
          : error?.status === 403
            ? "This update was denied. Refresh your staff session and reload current prices."
            : "The save outcome could not be confirmed. Reload current prices and review them before saving again.",
      );
    } finally {
      busy.current = false;
      if (alive.current) setSaving(false);
    }
  }

  if (!settings && loading)
    return <p role="status">Loading price configuration…</p>;
  if (!settings)
    return (
      <div role="alert" className="error-panel">
        <p>{loadError}</p>
        <button type="button" onClick={reload} disabled={loading}>
          Retry
        </button>
      </div>
    );
  const adult = settings.adult;
  const parsed = parseEuroInputToCents(adultInput);
  const preview = parsed.amountCents
    ? calculateDerivedChildCents(parsed.amountCents)
    : null;
  return (
    <section
      className="price-admin"
      aria-label="Price configuration"
      aria-busy={loading || saving}
    >
      <div className="price-summary" aria-label="Current prices">
        <h2>Current prices</h2>
        <p className="hint">
          One global price in EUR. Child tickets (age 12 and under) cost half
          the adult price, rounded to the nearest cent with half cents rounded
          up. Historical charged amounts are preserved.
        </p>
        {!adult && (
          <p role="status">
            Prices are not configured. Enter the first adult price to enable
            checkout quotes.
          </p>
        )}
        <dl className="price-meta">
          <div>
            <dt>Adult</dt>
            <dd>{formatCentsAsEur(adult?.amount_cents)}</dd>
          </div>
          <div>
            <dt>Child (derived)</dt>
            <dd>
              {adult
                ? formatCentsAsEur(
                    calculateDerivedChildCents(adult.amount_cents),
                  )
                : "-"}
            </dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd>{settings.version}</dd>
          </div>
          <div>
            <dt>Last updated</dt>
            <dd>{formatTimestamp(adult?.updated_at ?? adult?.updatedAt)}</dd>
          </div>
          <div>
            <dt>Updated by</dt>
            <dd>
              {adult?.updated_by_email ??
                adult?.updatedByEmail ??
                "Not recorded"}
            </dd>
          </div>
        </dl>
      </div>
      <form onSubmit={handleSubmit} noValidate className="price-form">
        <h2>Update global adult price</h2>
        <label htmlFor="adult-price-eur">Adult ticket price (EUR)</label>
        <input
          ref={inputRef}
          id="adult-price-eur"
          name="adultPriceEur"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          disabled={saving}
          value={adultInput}
          onChange={(event) => {
            setAdultInput(event.target.value);
          }}
          aria-invalid={Boolean(submitError)}
          aria-describedby="child-price-preview price-form-feedback"
        />
        <p
          id="child-price-preview"
          className="price-preview"
          aria-live="polite"
        >
          <span>Derived child price before save: </span>
          <strong>
            {preview !== null
              ? formatCentsAsEur(preview)
              : "Enter a valid adult price"}
          </strong>
        </p>
        {statusMessage && <p role="status">{statusMessage}</p>}
        <div id="price-form-feedback">
          {submitError && (
            <p role="alert" className="error-panel">
              {submitError}
            </p>
          )}
          {loadError && (
            <p role="alert" className="error-panel">
              {loadError}
            </p>
          )}
        </div>
        <div className="form-actions">
          <button type="submit" disabled={saving || loading || needsReload}>
            {saving ? "Saving…" : "Save price"}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={saving || loading}
            onClick={reload}
          >
            {loading
              ? "Loading…"
              : needsReload
                ? "Reload latest prices"
                : "Refresh prices"}
          </button>
        </div>
      </form>
    </section>
  );
}
