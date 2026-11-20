import { apiRequest, ApiError } from "../../../shared/services/apiClient.js";

function readTickets(data, items) {
  if (
    !Array.isArray(data.tickets) ||
    data.tickets.length !== items.length ||
    new Set(data.tickets.map((t) => t.seatId)).size !== items.length ||
    !data.tickets.every(
      (t) =>
        items.some((i) => i.seatId === t.seatId && i.category === t.category) &&
        Number.isSafeInteger(t.amountCharged) &&
        t.amountCharged > 0,
    ) ||
    !Number.isSafeInteger(data.totalCents) ||
    data.totalCents !==
      data.tickets.reduce((sum, t) => sum + t.amountCharged, 0)
  )
    throw new ApiError("The checkout response could not be verified.");
  return data;
}
export function createPrivateKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function getQuote(context, items, { signal } = {}) {
  const data = await timedRequest("/bookings/quote", {
    method: "POST",
    body: { screeningId: context.screening.id, seatId: items },
    signal,
    cache: "no-store",
  });
  if (
    !data ||
    data.screeningid !== context.screening.id ||
    data.screenId !== context.screen.id ||
    data.filmId !== context.film.id ||
    Date.parse(data.screeningTime) !==
      Date.parse(context.screening.screening_time) ||
    data.currency !== "EUR" ||
    !Number.isFinite(Date.parse(data.asOf)) ||
    !/^[0-9a-f]{64}$/.test(data.quoteFingerprint)
  )
    throw new ApiError(
      "Screening details changed. Return to seats and review your visit.",
    );
  return readTickets(data, items);
}
async function timedRequest(path, options) {
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 15000);
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  try {
    return await apiRequest(path, {
      ...options,
      signal: controller.signal,
      cache: "no-store",
    });
  } catch (error) {
    if (controller.signal.aborted && !options.signal?.aborted)
      throw new ApiError(
        "The cinema service did not respond in time. Try again.",
      );
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}
export async function createHold(attempt) {
  const data = await timedRequest("/bookings", {
    method: "POST",
    body: attempt.body,
    headers: { "Idempotency-Key": attempt.key },
  });
  if (
    !data ||
    !Number.isInteger(data.bookingId) ||
    data.bookingId <= 0 ||
    data.screeningid !== attempt.body.screeningId ||
    data.status !== "hold" ||
    data.paymentStatus !== "unpaid" ||
    data.holdToken !== attempt.key ||
    !Number.isFinite(Date.parse(data.expiresAt))
  )
    throw new ApiError(
      "The checkout outcome could not be verified. Retry the same request.",
    );
  readTickets(data, attempt.body.seatId);
  if (
    data.totalCents !== attempt.quote.totalCents ||
    !data.tickets.every((t) =>
      attempt.quote.tickets.some(
        (q) =>
          q.seatId === t.seatId &&
          q.category === t.category &&
          q.amountCharged === t.amountCharged,
      ),
    )
  )
    throw new ApiError(
      "The checkout outcome could not be verified. Retry the same request.",
    );
  return data;
}
export async function releaseHold(hold) {
  const data = await timedRequest(`/bookings/${hold.bookingId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${hold.holdToken}` },
  });
  if (
    data?.bookingId !== hold.bookingId ||
    data.status !== "expired" ||
    data.historyRetained !== true
  )
    throw new ApiError("The hold release could not be verified. Try again.");
  return data;
}
export const definitiveFailure = (error) =>
  [400, 404, 409, 503].includes(error.status) &&
  [
    "INVALID_BOOKING_REQUEST",
    "INVALID_CONTACT",
    "INVALID_TICKET",
    "DUPLICATE_SEATS",
    "INVALID_QUOTE",
    "INVALID_IDEMPOTENCY_KEY",
    "SCREENING_NOT_FOUND",
    "SCREENING_STARTED",
    "INVALID_SELECTION",
    "QUOTE_CHANGED",
    "PRICE_NOT_CONFIGURED",
    "ALLOCATION_CONFLICT",
    "HOLD_EXPIRED",
  ].includes(error.code);
