import { useEffect, useRef } from "react";

export default function SelectionSummary({
  city,
  film,
  screen,
  screening,
  showtime,
  selected,
  result,
  edit,
  changeScreening,
  onCheckout,
}) {
  const heading = useRef(null);
  useEffect(() => {
    heading.current?.focus();
  }, []);
  return (
    <section
      className="selection-summary selection-review"
      aria-labelledby="selection-review-title"
      data-screening-id={screening.id}
      data-screen-id={screen.id}
      data-city-id={city.id}
      data-film-id={film.id}
    >
      <p className="eyebrow">Review your choices</p>
      <h3 id="selection-review-title" tabIndex={-1} ref={heading}>
        Your selection summary
      </h3>
      <dl>
        <div>
          <dt>Movie</dt>
          <dd>{film.title}</dd>
        </div>
        <div>
          <dt>City</dt>
          <dd>{city.name}</dd>
        </div>
        <div>
          <dt>Screen</dt>
          <dd>{screen.capacity}-seat screen</dd>
        </div>
        <div>
          <dt>Showtime</dt>
          <dd>{showtime}</dd>
        </div>
      </dl>
      <h4>Selected places ({selected.length})</h4>
      <ul>
        {selected.map((place) => (
          <li key={place.id} data-seat-id={place.id}>
            {place.is_wheelchair
              ? `Wheelchair ${place.display_label}`
              : `Seat ${place.display_label} (row ${place.row_label})`}
          </li>
        ))}
      </ul>
      <p>
        Selection checked. These places are not reserved. Availability can
        change before checkout.
      </p>
      {!onCheckout && (
        <p className="selection-note">Payment is not available yet.</p>
      )}
      <time dateTime={result.as_of}>
        Checked at{" "}
        {new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Helsinki",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(new Date(result.as_of))}
      </time>
      <div className="seat-selection-actions">
        {onCheckout && (
          <button
            type="button"
            className="check-selection-button"
            onClick={onCheckout}
          >
            Continue to guest checkout
          </button>
        )}
        <button type="button" className="retry-button" onClick={edit}>
          Back to seats
        </button>
        <button
          type="button"
          className="retry-button"
          onClick={changeScreening}
        >
          Change screening
        </button>
      </div>
    </section>
  );
}
