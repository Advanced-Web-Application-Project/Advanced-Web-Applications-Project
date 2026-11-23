export class StaffAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function sendStaffError(res, error) {
  res.set("Cache-Control", "no-store");
  if (error instanceof StaffAuthError)
    return res
      .status(error.status)
      .json({ success: false, code: error.code, error: error.message });
  console.error("Staff request failed");
  return res.status(503).json({
    success: false,
    code: "STAFF_UNAVAILABLE",
    error: "The staff service is unavailable. Please retry.",
  });
}
