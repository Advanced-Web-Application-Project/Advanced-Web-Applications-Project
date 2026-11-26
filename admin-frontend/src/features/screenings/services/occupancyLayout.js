export const OCCUPANCY_STATES = {
  available: { label: "Available", symbol: "A" },
  hold: { label: "Active Hold", symbol: "H" },
  reserved: { label: "Unpaid Reservation", symbol: "R" },
  paid: { label: "Paid", symbol: "P" },
  company_secured: { label: "Company Secured", symbol: "C" },
  ceo: { label: "CEO Reserved", symbol: "CEO" },
};
const id = (value) =>
  Number.isInteger(value) && value > 0 && value <= 2147483647;
export function validateScreeningDetail(data, expectedId) {
  const show = data?.screening,
    a = data?.availability;
  if (
    !show ||
    show.id !== expectedId ||
    !id(show.id) ||
    !id(show.screen_id) ||
    !id(show.city_id) ||
    !id(show.film_id) ||
    typeof show.film_title !== "string" ||
    typeof show.city_name !== "string" ||
    !Number.isFinite(Date.parse(show.screening_time)) ||
    !a ||
    a.screening_id !== show.id ||
    a.screen_id !== show.screen_id ||
    !Number.isFinite(Date.parse(a.as_of)) ||
    typeof a.inventory_complete !== "boolean" ||
    ![100, 200].includes(a.seated?.total) ||
    a.wheelchair?.total !== 10 ||
    !Array.isArray(data.places)
  )
    throw Error("Unexpected screening detail");
  const ids = new Set(),
    positions = new Set();
  for (const p of data.places) {
    const position = `${p.physical_row}:${p.physical_column}`;
    if (
      !id(p.id) ||
      ids.has(p.id) ||
      positions.has(position) ||
      p.screen_id !== show.screen_id ||
      !Object.hasOwn(OCCUPANCY_STATES, p.occupancy_state) ||
      typeof p.display_label !== "string" ||
      !p.display_label ||
      typeof p.is_wheelchair !== "boolean" ||
      !Number.isInteger(p.row_label) ||
      !Number.isInteger(p.physical_column) ||
      p.physical_column < 1 ||
      p.physical_column > 10 ||
      (p.is_wheelchair
        ? p.physical_row !== 0
        : !Number.isInteger(p.physical_row) ||
          p.physical_row < 1 ||
          p.physical_row > a.seated.total / 10)
    )
      throw Error("Unexpected occupancy layout");
    ids.add(p.id);
    positions.add(position);
  }
  for (const [key, wheelchair] of [
    ["seated", false],
    ["wheelchair", true],
  ]) {
    const places = data.places.filter((p) => p.is_wheelchair === wheelchair);
    if (
      a.inventory_complete
        ? places.length !== a[key].total ||
          a[key].available !==
            places.filter((p) => p.occupancy_state === "available").length
        : a[key].available !== null
    )
      throw Error("Unexpected availability counts");
  }
  return data;
}
export function occupancyRows(places) {
  const rows = new Map();
  for (const place of places.filter((p) => !p.is_wheelchair)) {
    if (!rows.has(place.physical_row))
      rows.set(place.physical_row, {
        physicalRow: place.physical_row,
        label: place.row_label,
        places: [],
      });
    rows.get(place.physical_row).places.push(place);
  }
  return [...rows.values()]
    .sort((a, b) => b.physicalRow - a.physicalRow)
    .map((row) => ({
      ...row,
      places: row.places.sort((a, b) => a.physical_column - b.physical_column),
    }));
}
