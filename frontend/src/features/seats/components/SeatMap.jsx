import { useRef } from "react";
import { isUnavailable } from "../utils/seatLayout.js";

export default function SeatMap({
  layout,
  selectedIds,
  onToggle,
  disabled = false,
}) {
  const buttons = useRef(new Map());
  function navigate(event, place, zone) {
    let target;
    const row = zone.find((row) => row.some((p) => p.id === place.id));
    const index = row.findIndex((p) => p.id === place.id),
      rowIndex = zone.indexOf(row);
    if (event.key === "ArrowLeft") target = row[index - 1];
    else if (event.key === "ArrowRight") target = row[index + 1];
    else if (event.key === "ArrowUp") target = zone[rowIndex - 1]?.[index];
    else if (event.key === "ArrowDown") target = zone[rowIndex + 1]?.[index];
    else if (event.key === "Home") target = row[0];
    else if (event.key === "End") target = row.at(-1);
    else return;
    event.preventDefault();
    if (target) buttons.current.get(target.id)?.focus();
  }
  const seatedZone = layout.rows.map((row) => row.places),
    wheelchairZone = [layout.wheelchairs];
  function renderPlace(place, zone) {
    const unavailable = isUnavailable(place),
      selected = selectedIds.includes(place.id);
    const state = place.isReservedByCeo
      ? "CEO reserved"
      : unavailable
        ? "Unavailable"
        : selected
          ? "Selected"
          : "Available";
    const label = place.is_wheelchair
      ? `Wheelchair space ${place.display_label}`
      : `Row ${place.row_label}, seat ${place.display_label}`;
    return (
      <button
        key={place.id}
        ref={(button) => {
          if (button) buttons.current.set(place.id, button);
          else buttons.current.delete(place.id);
        }}
        type="button"
        className={`seat-place ${place.is_wheelchair ? "wheelchair-place" : ""} ${unavailable ? "place-unavailable" : selected ? "place-selected" : "place-available"}`}
        aria-label={`${label}, ${state.toLowerCase()}`}
        aria-pressed={selected}
        aria-disabled={unavailable || disabled}
        title={`${label} — ${state}`}
        onClick={() => {
          if (!unavailable && !disabled) onToggle(place.id);
        }}
        onKeyDown={(event) => navigate(event, place, zone)}
      >
        <span aria-hidden="true" className="seat-state-symbol">
          {unavailable ? "×" : selected ? "✓" : place.is_wheelchair ? "♿" : ""}
        </span>
        <span>{place.display_label}</span>
      </button>
    );
  }
  return (
    <div className="seat-layout" role="group" aria-label="Auditorium places">
      <div className="seat-layout-content">
        <div
          className="seated-zone"
          role="group"
          aria-label="Seated places. Row 1 is nearest the screen."
        >
          {layout.rows.map((row) => (
            <div
              key={row.physicalRow}
              className="seat-row"
              role="group"
              aria-label={`Row ${row.label}`}
            >
              <span className="seat-row-label" aria-hidden="true">
                {row.label}
              </span>
              <div className="seat-row-places">
                {row.places.map((place) => renderPlace(place, seatedZone))}
              </div>
            </div>
          ))}
        </div>
        <div
          className="wheelchair-zone"
          role="group"
          aria-label="Wheelchair spaces, between row 1 and the screen"
        >
          <p>Wheelchair spaces</p>
          <div className="seat-row">
            <span className="seat-row-label" aria-hidden="true">
              W
            </span>
            <div className="seat-row-places">
              {layout.wheelchairs.map((place) =>
                renderPlace(place, wheelchairZone),
              )}
            </div>
          </div>
        </div>
        <div className="auditorium-screen">Screen</div>
      </div>
    </div>
  );
}
