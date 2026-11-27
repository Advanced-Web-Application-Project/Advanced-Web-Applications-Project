export class CustomerAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendCustomerError(res, error) {
  res.set("Cache-Control", "no-store");
  if (error instanceof CustomerAuthError)
    return res
      .status(error.status)
      .json({ success: false, code: error.code, error: error.message });
  console.error("Customer authentication request failed");
  return res.status(503).json({
    success: false,
    code: "CUSTOMER_AUTH_UNAVAILABLE",
    error: "Customer sign-in is unavailable. Please retry.",
  });
}
