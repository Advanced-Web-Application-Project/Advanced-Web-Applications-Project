export function occupancyData(id = 1, capacity = 100) {
  const places = [];
  for (let row = 1; row <= capacity / 10; row++)
    for (let col = 1; col <= 10; col++) {
      const ordinal = (row - 1) * 10 + (row % 2 ? col : 11 - col),
        label = ordinal >= 13 ? ordinal + 1 : ordinal;
      places.push({
        id: ordinal,
        screen_id: 11,
        display_label: String(label),
        physical_row: row,
        physical_column: col,
        row_label: row >= 13 ? row + 1 : row,
        is_wheelchair: false,
        occupancy_state:
          ordinal === 1
            ? "ceo"
            : ordinal === 2
              ? "hold"
              : ordinal === 3
                ? "reserved"
                : ordinal === 4
                  ? "paid"
                  : ordinal === 5
                    ? "company_secured"
                    : "available",
      });
    }
  for (let col = 1; col <= 10; col++)
    places.push({
      id: capacity + col,
      screen_id: 11,
      display_label: `W${col}`,
      physical_row: 0,
      physical_column: col,
      row_label: 0,
      is_wheelchair: true,
      occupancy_state: "available",
    });
  return {
    screening: {
      id,
      screen_id: 11,
      city_id: 7,
      city_name: "Oulu",
      film_id: 3,
      film_title: `Film ${id}`,
      screening_time: "2030-01-15T16:00:00Z",
    },
    availability: {
      screen_id: 11,
      screening_id: id,
      as_of: "2030-01-15T10:00:00Z",
      inventory_complete: true,
      seated: { total: capacity, available: capacity - 5 },
      wheelchair: { total: 10, available: 10 },
    },
    places,
  };
}
