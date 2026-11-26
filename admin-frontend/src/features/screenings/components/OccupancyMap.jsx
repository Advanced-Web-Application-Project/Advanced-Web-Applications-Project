import { useRef, useState } from "react";
import {
  OCCUPANCY_STATES,
  occupancyRows,
} from "../services/occupancyLayout.js";
function Zone({ rows, label }) {
  const refs = useRef(new Map());
  const [focused, setFocused] = useState(null);
  const first = rows[0]?.places[0]?.id;
  function navigate(event, row, index) {
    let next;
    const rowIndex = rows.indexOf(row);
    if (event.key === "ArrowLeft") next = row.places[index - 1];
    else if (event.key === "ArrowRight") next = row.places[index + 1];
    else if (event.key === "ArrowUp") next = rows[rowIndex - 1]?.places[index];
    else if (event.key === "ArrowDown")
      next = rows[rowIndex + 1]?.places[index];
    else if (event.key === "Home") next = row.places[0];
    else if (event.key === "End") next = row.places.at(-1);
    else return;
    event.preventDefault();
    if (next) refs.current.get(next.id)?.focus();
  }
  return (
    <div
      role="grid"
      aria-label={label}
      aria-readonly="true"
      className="occupancy-zone"
    >
      {rows.map((row) => (
        <div role="row" key={row.physicalRow} className="seat-row">
          <span role="rowheader" className="seat-row-label">
            {row.label}
          </span>
          <div role="presentation" className="seat-row-places">
            {row.places.map((place, index) => {
              const state = OCCUPANCY_STATES[place.occupancy_state];
              const name = place.is_wheelchair
                ? `Wheelchair space ${place.display_label}`
                : `Row ${place.row_label}, seat ${place.display_label}`;
              return (
                <div
                  role="gridcell"
                  key={place.id}
                  tabIndex={(focused ?? first) === place.id ? 0 : -1}
                  ref={(node) => {
                    if (node) refs.current.set(place.id, node);
                    else refs.current.delete(place.id);
                  }}
                  onFocus={() => setFocused(place.id)}
                  onKeyDown={(event) => navigate(event, row, index)}
                  className={`seat-place ${place.is_wheelchair ? "wheelchair-place" : ""} ${place.occupancy_state === "available" ? "place-available" : "place-unavailable"} occupancy-${place.occupancy_state}`}
                  aria-label={`${name}, ${state.label.toLowerCase()}`}
                  title={`${name} — ${state.label}`}
                >
                  <span aria-hidden="true" className="seat-state-symbol">
                    {state.symbol}
                  </span>
                  <span aria-hidden="true">{place.display_label}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
export default function OccupancyMap({ places }) {
  const rows = occupancyRows(places),
    wheelchairs = places
      .filter((p) => p.is_wheelchair)
      .sort((a, b) => a.physical_column - b.physical_column);
  return (
    <section className="occupancy-map" aria-label="Read-only occupancy map">
      <h2>Place occupancy</h2>
      <p className="hint">
        Read only. Use arrow keys to inspect places; Home and End move within a
        row. Row 1 is nearest the screen.
      </p>
      <ul
        className="seat-legend occupancy-legend"
        aria-label="Occupancy legend"
      >
        {Object.entries(OCCUPANCY_STATES).map(([key, value]) => (
          <li key={key}>
            <span
              className={`legend-place ${key === "available" ? "place-available" : "place-unavailable"} occupancy-${key}`}
              aria-hidden="true"
            >
              {value.symbol}
            </span>
            {value.label}
          </li>
        ))}
      </ul>
      <div
        className="seat-layout occupancy-scroll"
        tabIndex={0}
        role="group"
        aria-label="Auditorium layout. Scroll horizontally on small screens."
      >
        <div className="seat-layout-content">
          <Zone rows={rows} label="Seated occupancy" />
          <div className="wheelchair-zone">
            <Zone
              rows={[{ physicalRow: 0, label: "W", places: wheelchairs }]}
              label="Wheelchair occupancy"
            />
          </div>
          <div className="auditorium-screen">Screen</div>
        </div>
      </div>
      <p className="hint">
        Letters and labels identify each state. Auto refresh pauses while you
        inspect the map. Viewing does not hold or release places.
      </p>
    </section>
  );
}
