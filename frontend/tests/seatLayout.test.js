import test from "node:test";
import assert from "node:assert/strict";
import {
  readSeatLayout,
  readSelectionResult,
  isUnavailable,
} from "../src/features/seats/utils/seatLayout.js";
import { seatData, selectionResponse } from "./fixtures/seatData.js";
for (const capacity of [100, 200])
  test(`${capacity}: server positions determine top-to-bottom rows, snake labels and separate wheelchairs`, () => {
    const seats = seatData(capacity).reverse(),
      layout = readSeatLayout(seats, 11, capacity);
    assert.equal(layout.rows[0].physicalRow, capacity / 10);
    assert.equal(layout.rows.at(-1).physicalRow, 1);
    assert.deepEqual(
      layout.rows
        .find((r) => r.physicalRow === 2)
        .places.map((s) => s.display_label),
      ["21", "20", "19", "18", "17", "16", "15", "14", "12", "11"],
    );
    if (capacity === 200)
      assert.equal(layout.rows.find((r) => r.physicalRow === 13).label, 14);
    assert.deepEqual(
      layout.wheelchairs.map((s) => s.display_label),
      Array.from({ length: 10 }, (_, i) => `W${i + 1}`),
    );
    assert.equal(seats[0].physical_row, 0, "input order is not mutated");
  });
test("incomplete, duplicated, foreign-screen and malformed layouts fail closed; empty inventory is distinct", () => {
  assert.deepEqual(readSeatLayout([], 11, 100), {
    rows: [],
    wheelchairs: [],
    places: [],
  });
  const seats = seatData();
  for (const rows of [
    null,
    seats.slice(1),
    [...seats.slice(1), seats[1]],
    seats.map((p, i) => (i ? p : { ...p, screen_id: 99 })),
    seats.map((p, i) => (i ? p : { ...p, isBooked: undefined })),
    seats.map((p, i) => (i ? p : { ...p, physical_column: 11 })),
  ])
    assert.throws(() => readSeatLayout(rows, 11, 100));
});
test("screening state controls selectability, including a future authorised CEO release", () => {
  assert.equal(isUnavailable({ isBooked: true, isReservedByCeo: false }), true);
  assert.equal(isUnavailable({ isBooked: false, isReservedByCeo: true }), true);
  assert.equal(
    isUnavailable({
      isBooked: false,
      isReservedByCeo: false,
      is_ceo_reserved: true,
    }),
    false,
  );
});
test("validation results must match the requested screening and complete ID set", () => {
  const request = { screenId: 11, screeningId: 111, seatIds: [11002, 11003] },
    result = selectionResponse(request);
  assert.equal(readSelectionResult(result, request), result);
  for (const change of [
    { screening_id: 112 },
    { screen_id: 12 },
    { seat_ids: [11002] },
    { seat_ids: [11002, 11002] },
    { seat_ids: [11002, 11004] },
    { as_of: "bad" },
    { valid: "true" },
    { valid: false },
    { errors: [{ message: "broken" }] },
  ])
    assert.throws(() => readSelectionResult({ ...result, ...change }, request));
});
