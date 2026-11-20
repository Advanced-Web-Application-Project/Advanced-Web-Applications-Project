import { useEffect, useId, useRef } from "react";
import { useGuestCheckout } from "../hooks/useGuestCheckout.js";
const money = (cents) =>
  new Intl.NumberFormat("en-GB", { style: "currency", currency: "EUR" }).format(
    cents / 100,
  );
const placeLabel = (p) =>
  p.is_wheelchair
    ? `Wheelchair ${p.display_label}`
    : `Seat ${p.display_label} (row ${p.row_label})`;

export default function GuestCheckout({ context, onBack }) {
  const checkout = useGuestCheckout(context, onBack),
    id = useId(),
    heading = useRef(null),
    emailControl = useRef(null);
  const { state, quote, locked, busy, remaining } = checkout;
  useEffect(() => {
    heading.current?.focus();
  }, [state.hold]);
  const emailInvalid = state.error === "Enter a valid email address.";
  useEffect(() => {
    if (emailInvalid) emailControl.current?.focus();
  }, [emailInvalid]);
  const held = Boolean(state.hold);
  return (
    <section
      id="cinemas"
      className="selection-summary guest-checkout"
      aria-labelledby={`${id}-title`}
    >
      <p className="eyebrow">Your visit</p>
      <h2 id={`${id}-title`} tabIndex={-1} ref={heading}>
        {held ? "Your checkout hold" : "Guest checkout"}
      </h2>
      <dl>
        <div>
          <dt>Movie</dt>
          <dd>{context.film.title}</dd>
        </div>
        <div>
          <dt>City</dt>
          <dd>{context.city.name}</dd>
        </div>
        <div>
          <dt>Screen</dt>
          <dd>{context.screen.capacity}-seat screen</dd>
        </div>
        <div>
          <dt>Showtime</dt>
          <dd>{context.showtime}</dd>
        </div>
      </dl>
      <form noValidate onSubmit={checkout.start}>
        <fieldset disabled={locked || busy} className="checkout-fields">
          <legend>Ticket categories</legend>
          <p className="selection-note">
            Child tickets are for ages 12 and under, including wheelchair
            places.
          </p>
          <ul className="checkout-tickets">
            {checkout.items.map((item) => {
              const place = context.selected.find((p) => p.id === item.seatId),
                ticket = quote?.data?.tickets.find(
                  (t) => t.seatId === item.seatId,
                );
              return (
                <li
                  key={item.seatId}
                  data-seat-id={item.seatId}
                  className="selection-field"
                >
                  <label htmlFor={`${id}-${item.seatId}`}>
                    Ticket for {placeLabel(place)}
                  </label>
                  <select
                    id={`${id}-${item.seatId}`}
                    value={item.category}
                    onChange={(event) =>
                      checkout.setCategory(item.seatId, event.target.value)
                    }
                  >
                    <option value="adult">Adult</option>
                    <option value="child">Child (12 or under)</option>
                  </select>
                  {ticket && (
                    <span className="ticket-price">
                      {money(ticket.amountCharged)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="selection-field">
            <label htmlFor={`${id}-email`}>Email address</label>
            <input
              id={`${id}-email`}
              ref={emailControl}
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={checkout.email}
              onChange={(event) => checkout.setEmail(event.target.value)}
              aria-invalid={emailInvalid || undefined}
              aria-describedby={`${id}-email-help${emailInvalid ? ` ${id}-error` : ""}`}
            />
            <p id={`${id}-email-help`} className="field-feedback">
              No account is required.
            </p>
          </div>
        </fieldset>
        {!held && (
          <>
            {!quote && <p role="status">Loading current prices…</p>}
            {quote?.error && (
              <div role="alert">
                <p>{quote.error}</p>
                <button
                  type="button"
                  className="retry-button"
                  onClick={checkout.retryQuote}
                  disabled={locked || busy}
                >
                  Retry prices
                </button>
              </div>
            )}
            {quote?.data && (
              <>
                <p className="checkout-total">
                  Total: <strong>{money(quote.data.totalCents)}</strong>
                </p>
                <p className="selection-note">
                  {state.attempt
                    ? "Keep this page open while we confirm your checkout."
                    : "Your places are not held yet. Starting checkout holds them for five minutes. No payment is taken."}
                </p>
              </>
            )}
          </>
        )}
        {state.error && (
          <p id={`${id}-error`} role="alert">
            {state.error}
          </p>
        )}
        {held && (
          <div className="hold-status">
            {remaining > 0 ? (
              <>
                <p role="status">
                  Places held for checkout. Your booking is unpaid.
                </p>
                <p>
                  Time remaining:{" "}
                  <span role="timer" aria-live="off">
                    {Math.floor(remaining / 60)}:
                    {String(remaining % 60).padStart(2, "0")}
                  </span>
                </p>
              </>
            ) : (
              <p role="alert">
                Your hold time has ended. Return to seats and check availability
                again.
              </p>
            )}
            <p>
              Total: <strong>{money(state.hold.totalCents)}</strong>
            </p>
            <p>
              Held until{" "}
              <time dateTime={state.hold.expiresAt}>
                {new Intl.DateTimeFormat("en-GB", {
                  timeZone: "Europe/Helsinki",
                  hour: "2-digit",
                  minute: "2-digit",
                }).format(new Date(state.hold.expiresAt))}
              </time>
              .
            </p>
            <p>Payment is not available yet. No payment has been taken.</p>
          </div>
        )}
        <div className="seat-selection-actions">
          {!held && (
            <button
              type="submit"
              className="check-selection-button"
              disabled={busy || (!state.attempt && !quote?.data)}
            >
              {state.phase === "creating"
                ? "Starting checkout…"
                : state.attempt
                  ? "Retry checkout"
                  : "Start five-minute checkout"}
            </button>
          )}
          <button
            type="button"
            className="retry-button"
            onClick={checkout.cancel}
            disabled={busy}
          >
            {state.phase === "releasing"
              ? "Returning to seats…"
              : locked
                ? "Cancel checkout and return to seats"
                : "Back to seats"}
          </button>
        </div>
      </form>
    </section>
  );
}
