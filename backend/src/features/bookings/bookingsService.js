import { requireStaffPermission } from "../staff/staffAccess.js";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  MAX_DATABASE_ID,
  validateSeatSelection,
} from "../seats/seatSelectionValidation.js";
import { createSeatsRepository } from "../seats/seatsRepository.js";

export class BookingError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
const isDatabaseId = (id) =>
  Number.isInteger(id) && id > 0 && id <= MAX_DATABASE_ID;
const hashHoldToken = (value) =>
  createHash("sha256").update(value).digest("hex");

// Retry keys are private 256-bit credentials, not public UUID/correlation IDs.
export function parseHoldRequestKey(value) {
  if (value === undefined) return null;
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(value) ||
    Buffer.from(value, "base64url").length !== 32 ||
    Buffer.from(value, "base64url").toString("base64url") !== value
  )
    throw new BookingError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key must be a private 32-byte random value encoded as canonical base64url",
    );
  return value;
}

export function fingerprintHoldRequest(request) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        screeningId: request.screeningId,
        clientEmail: request.clientEmail,
        items: [...request.items].sort((a, b) => a.seatId - b.seatId),
        ...(request.expectedQuote
          ? { expectedQuote: request.expectedQuote }
          : {}),
      }),
    )
    .digest("hex");
}

function holdResponse(hold, tickets, holdToken) {
  return {
    bookingId: hold.id,
    screeningid: hold.screening_id,
    status: "hold",
    paymentStatus: "unpaid",
    expiresAt: hold.expires_at,
    holdToken,
    totalCents: tickets.reduce(
      (total, ticket) => total + ticket.amountCharged,
      0,
    ),
    tickets: tickets.map(({ seatId, category, amountCharged }) => ({
      seatId,
      category,
      amountCharged,
    })),
  };
}

export function parseTicketSelection(body) {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !isDatabaseId(body.screeningId) ||
    !Array.isArray(body.seatId) ||
    body.seatId.length < 1 ||
    body.seatId.length > 210
  )
    throw new BookingError(
      400,
      "INVALID_BOOKING_REQUEST",
      "screeningId and 1–210 seatId entries are required as JSON integer IDs",
    );
  const items = Array.from(body.seatId, (item) => {
    const isTicketObject =
      item !== null && typeof item === "object" && !Array.isArray(item);
    const seatId = isTicketObject ? item.seatId : item;
    const category =
      isTicketObject && item.category !== undefined ? item.category : "adult";
    if (
      !isDatabaseId(seatId) ||
      typeof category !== "string" ||
      !["adult", "child"].includes(category.toLowerCase())
    )
      throw new BookingError(
        400,
        "INVALID_TICKET",
        "Each place needs a positive integer seatId and adult or child category; company bookings require their authorised workflow",
      );
    return { seatId, category: category.toLowerCase() };
  });
  if (new Set(items.map((item) => item.seatId)).size !== items.length)
    throw new BookingError(
      400,
      "DUPLICATE_SEATS",
      "Duplicate seat IDs are not allowed",
    );
  return { screeningId: body.screeningId, items };
}

export function parseBookingRequest(body) {
  const selection = parseTicketSelection(body);
  if (
    typeof body.clientEmail !== "string" ||
    body.clientEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.clientEmail.trim())
  )
    throw new BookingError(
      400,
      "INVALID_CONTACT",
      "A valid clientEmail is required",
    );

  if (
    body.expectedQuote !== undefined &&
    (typeof body.expectedQuote !== "string" ||
      !/^[0-9a-f]{64}$/.test(body.expectedQuote))
  )
    throw new BookingError(
      400,
      "INVALID_QUOTE",
      "expectedQuote must be the server quote fingerprint",
    );
  return {
    ...selection,
    clientEmail: body.clientEmail.trim(),
    ...(body.expectedQuote !== undefined
      ? { expectedQuote: body.expectedQuote }
      : {}),
  };
}

function quoteTickets(prices, items) {
  const adult = prices.filter((price) => price.category === "adult");
  if (
    adult.length !== 1 ||
    !Number.isInteger(adult[0].amount_cents) ||
    adult[0].amount_cents <= 0
  )
    throw new BookingError(
      503,
      "PRICE_NOT_CONFIGURED",
      "Exactly one positive adult base price must be configured",
    );
  if (
    items.some((item) => item.category === "child") &&
    adult[0].amount_cents % 2
  )
    throw new BookingError(
      503,
      "PRICE_NOT_CONFIGURED",
      "Child pricing needs an even adult amount in cents until a rounding policy is agreed",
    );
  return items.map((item) => ({
    ...item,
    priceId: adult[0].id,
    amountCharged:
      item.category === "child"
        ? adult[0].amount_cents / 2
        : adult[0].amount_cents,
  }));
}

function quoteFingerprint(screening, tickets) {
  return createHash("sha256")
    .update(
      JSON.stringify({
        screeningId: screening.id,
        screenId: screening.screen_id,
        filmId: screening.film_id,
        screeningTime: screening.screening_time,
        currency: "EUR",
        tickets: tickets
          .map(({ seatId, category, amountCharged }) => ({
            seatId,
            category,
            amountCharged,
          }))
          .sort((a, b) => a.seatId - b.seatId),
      }),
    )
    .digest("hex");
}

async function checkedSelection(client, transaction, request) {
  const screening = await transaction.lockScreening(request.screeningId);
  if (!screening)
    throw new BookingError(404, "SCREENING_NOT_FOUND", "Screening not found");
  if (!screening.is_future)
    throw new BookingError(
      409,
      "SCREENING_STARTED",
      "The screening has already started",
    );
  const snapshot = await createSeatsRepository(
    client,
  ).findScreeningAvailability(screening.screen_id, request.screeningId);
  const selection = validateSeatSelection(
    snapshot,
    request.items.map((item) => item.seatId),
  );
  if (!selection.valid)
    throw new BookingError(
      409,
      "INVALID_SELECTION",
      "The complete selection is no longer valid",
      selection.errors,
    );
  const tickets = quoteTickets(await transaction.readPrices(), request.items);
  return { screening, snapshot, tickets };
}

export function createBookingsService(repository) {
  return {
    async quote(body) {
      const request = parseTicketSelection(body);
      return repository.transaction(async (client, transaction) => {
        const { screening, snapshot, tickets } = await checkedSelection(
          client,
          transaction,
          request,
        );
        return {
          screeningid: screening.id,
          screenId: screening.screen_id,
          filmId: screening.film_id,
          screeningTime: screening.screening_time,
          currency: "EUR",
          asOf: snapshot.as_of,
          quoteFingerprint: quoteFingerprint(screening, tickets),
          totalCents: tickets.reduce(
            (total, ticket) => total + ticket.amountCharged,
            0,
          ),
          tickets: tickets.map(({ seatId, category, amountCharged }) => ({
            seatId,
            category,
            amountCharged,
          })),
        };
      });
    },
    async listBookings(query, actor) {
      requireStaffPermission(actor, "bookings:read");
      if (Object.keys(query).some((key) => key.startsWith("screeningId[")))
        throw new BookingError(
          400,
          "INVALID_SCREENING",
          "screeningId must be a positive integer",
        );
      let screeningId;
      if (query.screeningId !== undefined) {
        if (
          typeof query.screeningId !== "string" ||
          !/^\d+$/.test(query.screeningId) ||
          !isDatabaseId(Number(query.screeningId))
        )
          throw new BookingError(
            400,
            "INVALID_SCREENING",
            "screeningId must be a positive integer",
          );
        screeningId = Number(query.screeningId);
      }
      if (screeningId !== undefined) {
        const cityId = await repository.findScreeningCity(screeningId);
        if (cityId === null)
          throw new BookingError(
            404,
            "SCREENING_NOT_FOUND",
            "Screening not found",
          );
        requireStaffPermission(actor, "bookings:read", { cityId });
      }
      return repository.listBookings(
        screeningId,
        actor.role === "cashier" ? actor.cityId : undefined,
      );
    },
    async createHold(body, idempotencyKey) {
      const request = parseBookingRequest(body);
      const requestKey = parseHoldRequestKey(idempotencyKey);
      const holdToken = requestKey ?? randomBytes(32).toString("base64url");
      const tokenHash = hashHoldToken(holdToken);
      const fingerprint = requestKey ? fingerprintHoldRequest(request) : null;
      return repository.transaction(async (client, transaction) => {
        if (requestKey) {
          // Always claim request identity before screen/screening/booking locks.
          await transaction.lockRequestKey(tokenHash);
          const existing = await transaction.findHoldByTokenHash(tokenHash);
          if (existing) {
            if (
              !existing.hold_request_fingerprint ||
              existing.hold_request_fingerprint !== fingerprint
            )
              throw new BookingError(
                409,
                "IDEMPOTENCY_KEY_CONFLICT",
                "This private request key was already used for another request",
              );
            const hold = await transaction.lockBooking(existing.id);
            if (
              hold.status === "expired" ||
              (hold.status === "hold" &&
                !(await transaction.isHoldActive(hold.id)))
            )
              throw new BookingError(
                409,
                "HOLD_EXPIRED",
                "This hold has expired or was released. Review availability and use a new private request key",
              );
            if (hold.booking_type !== "customer" || hold.status !== "hold")
              throw new BookingError(
                409,
                "HOLD_NOT_ACTIVE",
                "This request no longer refers to an active unpaid customer hold",
              );
            return holdResponse(
              hold,
              await transaction.readHoldTickets(hold.id),
              holdToken,
            );
          }
        }
        const { screening, tickets } = await checkedSelection(
          client,
          transaction,
          request,
        );
        if (
          request.expectedQuote &&
          request.expectedQuote !== quoteFingerprint(screening, tickets)
        )
          throw new BookingError(
            409,
            "QUOTE_CHANGED",
            "Prices or screening details changed. Review a new quote before starting checkout",
          );
        const hold = await transaction.insertHold(
          request.screeningId,
          request.clientEmail,
          tokenHash,
          fingerprint,
        );
        for (const ticket of tickets)
          await transaction.insertTicket(hold.id, ticket);
        return holdResponse(hold, tickets, holdToken);
      });
    },
    async releaseHold(id, authorization) {
      if (
        typeof id !== "string" ||
        !/^\d+$/.test(id) ||
        !isDatabaseId(Number(id))
      )
        throw new BookingError(
          400,
          "INVALID_BOOKING",
          "Booking ID must be a positive integer",
        );
      const match =
        typeof authorization === "string" &&
        /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
      if (!match)
        throw new BookingError(
          401,
          "HOLD_TOKEN_REQUIRED",
          "A private hold token is required",
        );
      return repository.transaction(async (_, transaction) => {
        const booking = await transaction.lockBooking(Number(id));
        const hash = hashHoldToken(match[1]);
        if (
          !booking?.hold_token_hash ||
          !timingSafeEqual(
            Buffer.from(hash, "hex"),
            Buffer.from(booking.hold_token_hash, "hex"),
          )
        )
          throw new BookingError(404, "HOLD_NOT_FOUND", "Hold not found");
        if (
          booking.booking_type !== "customer" ||
          !["hold", "expired"].includes(booking.status)
        )
          throw new BookingError(
            409,
            "HOLD_NOT_RELEASABLE",
            "Only an owned unpaid hold can be released; booking history is retained",
          );
        if (booking.status === "hold") await transaction.expireHold(booking.id);
        return {
          bookingId: booking.id,
          status: "expired",
          historyRetained: true,
        };
      });
    },
  };
}
