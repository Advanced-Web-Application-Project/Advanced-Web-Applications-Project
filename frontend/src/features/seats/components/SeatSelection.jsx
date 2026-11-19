import { useId } from "react";
import { useSeatSelection } from "../hooks/useSeatSelection.js";
import SeatMap from "./SeatMap.jsx";

function ScreeningPlaces({ screen, screening, onValidatedSelection }) {
  const id = useId();
  const state = useSeatSelection({
    screenId: screen.id,
    screeningId: screening.id,
    capacity: screen.capacity,
    onValidatedSelection,
  });
  const selected = state.selected
    .map((id) => state.layout?.places.find((p) => p.id === id))
    .filter(Boolean);
  const ready = state.loadState === "ready",
    checking = state.validation.status === "checking";
  const checked = state.validation.status === "checked",
    result = state.validation.result;
  return (
    <section className="seat-selection" aria-labelledby={`${id}-title`}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">Choose your places</p>
          <h3 id={`${id}-title`}>Seats for this screening</h3>
        </div>
        <button
          type="button"
          className="retry-button"
          onClick={state.refresh}
          disabled={
            state.loadState === "loading" || state.loadState === "refreshing"
          }
        >
          Refresh seats
        </button>
      </div>
      <p className="seat-instructions">
        Choose all your places, then check the complete selection. Use Tab to
        move through places, arrow keys to move across rows, and Space or Enter
        to select. Unavailable places are labelled and marked ×. On narrow
        screens, scroll the map sideways.
      </p>
      <ul className="seat-legend" aria-label="Place states">
        <li>
          <span className="legend-place place-available" aria-hidden="true" />
          Available
        </li>
        <li>
          <span className="legend-place place-selected" aria-hidden="true">
            ✓
          </span>
          Selected
        </li>
        <li>
          <span className="legend-place place-unavailable" aria-hidden="true">
            ×
          </span>
          Unavailable
        </li>
        <li>♿ Wheelchair space</li>
      </ul>
      <p className="seat-feedback" role="status" aria-atomic="true">
        {state.notice}
      </p>
      {state.loadState === "error" && (
        <p role="alert">
          Seat availability could not be loaded. Use Refresh seats to retry.
        </p>
      )}
      {state.layout &&
        state.loadState !== "error" &&
        (state.layout.places.length ? (
          <SeatMap
            layout={state.layout}
            selectedIds={state.selected}
            onToggle={state.toggle}
            disabled={!ready}
          />
        ) : (
          <p>
            No places are listed for this screening. Choose another showtime or
            refresh.
          </p>
        ))}
      <div className="seat-selection-actions">
        <div>
          <h4>
            Your places <span>({selected.length})</span>
          </h4>
          <p>
            {selected.length
              ? selected
                  .map((p) =>
                    p.is_wheelchair
                      ? `Wheelchair ${p.display_label}`
                      : `Seat ${p.display_label} (row ${p.row_label})`,
                  )
                  .join(", ")
              : "No places selected."}
          </p>
        </div>
        <button
          type="button"
          className="check-selection-button"
          onClick={state.check}
          disabled={!ready || !state.selected.length || checking}
        >
          {checking ? "Checking selection…" : "Check selection"}
        </button>
      </div>
      {checked && !result.valid && (
        <div className="seat-validation-errors" role="alert">
          <h4>Change your selection</h4>
          <ul>
            {result.errors.map((error, index) => (
              <li key={`${error.code}-${index}`}>{error.message}</li>
            ))}
          </ul>
          <p>Refresh seats if availability has changed.</p>
        </div>
      )}
      {state.validation.status === "error" && (
        <p role="alert">
          Your selection could not be checked. Try Check selection again.
        </p>
      )}
      {checked && result.valid && (
        <p className="selection-valid">
          ✓ Selection checked. These places are not reserved.
        </p>
      )}
      <p className="selection-note">
        Availability refreshes every 30 seconds and when you return to this
        window. Seat choices and checks do not create a booking or hold.
      </p>
    </section>
  );
}

// Own the screening boundary so even direct prop changes discard old state/results.
export default function SeatSelection(props) {
  return (
    <ScreeningPlaces
      key={`${props.screen.id}:${props.screening.id}`}
      {...props}
    />
  );
}
