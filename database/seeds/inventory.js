// Row zero is the separate wheelchair zone; columns run left to right.
export function generateScreenInventory(capacity) {
  if (![100, 200].includes(capacity))
    throw new RangeError("Screen capacity must be 100 or 200");
  const places = [];
  for (let row = 1; row <= capacity / 10; row += 1) {
    for (let column = 1; column <= 10; column += 1) {
      const ordinal = (row - 1) * 10 + (row % 2 ? column : 11 - column);
      const label = ordinal >= 13 ? ordinal + 1 : ordinal;
      places.push({
        physical_row: row,
        physical_column: column,
        row_label: row >= 13 ? row + 1 : row,
        seat_label: label,
        display_label: String(label),
        is_wheelchair: false,
        is_ceo_reserved: ordinal === 1,
      });
    }
  }
  for (let label = 1; label <= 10; label += 1)
    places.push({
      physical_row: 0,
      physical_column: label,
      row_label: 0,
      seat_label: label,
      display_label: `W${label}`,
      is_wheelchair: true,
      is_ceo_reserved: false,
    });
  return places;
}
