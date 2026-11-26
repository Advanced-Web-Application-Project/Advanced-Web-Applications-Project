const MAX_AMOUNT_CENTS = 2147483647;

export function calculateDerivedChildCents(adultAmountCents) {
  if (
    typeof adultAmountCents !== "number" ||
    adultAmountCents <= 0 ||
    !Number.isInteger(adultAmountCents) ||
    adultAmountCents > MAX_AMOUNT_CENTS
  ) {
    return null;
  }
  return Math.ceil(adultAmountCents / 2);
}

export function parseEuroInputToCents(raw) {
  if (typeof raw !== "string") {
    return { error: "input must be a valid amount of euro" };
  }

  const normalized = raw.trim().replace(",", ".");
  if (!normalized) {
    return { error: "Enter a positive amount of euro " };
  }

  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    return {
      error: "Enter a positive amount in euros with max two decimal",
    };
  }
  const [eurosPart, centsPart = ""] = normalized.split(".");
  const euros = Number(eurosPart);
  const cents = Number(centsPart.padEnd(2, "0"));
  if (!Number.isSafeInteger(euros) || !Number.isSafeInteger(cents)) {
    return { error: "Amount is outside the supported amount" };
  }
  const amountCents = euros * 100 + cents;
  if (amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) {
    return {
      error: `Amount must be greater than 0 and between ${MAX_AMOUNT_CENTS}`,
    };
  }
  return { amountCents };
}

export function formatCentsAsEur(amountCents) {
  if (
    typeof amountCents !== "number" ||
    !Number.isInteger(amountCents) ||
    amountCents < 0
  ) {
    return "-";
  }
  return `€${(amountCents / 100).toFixed(2)}`;
}

const helsinkiDate = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Helsinki",
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatTimestamp(value) {
  if (!value) {
    return "Not recorded";
  }

  const parsedDate = new Date(value);
  const isValidDate = !Number.isNaN(parsedDate.getTime());

  if (!isValidDate) {
    return String(value);
  }

  return helsinkiDate.format(parsedDate);
}

export function createPriceAdminService(model) {
  return {
    listPrices: (signal) => model.request("/staff/prices", { signal }),
    updateAdultPrice: ({ amountCents, expectedVersion }, signal) =>
      model.request("/prices", {
        method: "PUT",
        signal,
        body: { category: "adult", amountCents, expectedVersion },
      }),
  };
}
