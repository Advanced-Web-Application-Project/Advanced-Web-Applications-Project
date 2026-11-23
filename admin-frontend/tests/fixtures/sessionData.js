export function identity(
  role = "administrator",
  id = 1,
  cityId = role === "cashier" ? 7 : null,
) {
  return {
    user: { id, role, cityId },
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    csrfToken: "a".repeat(43),
  };
}
export const response = (data, status = 200, code = "") => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () =>
    status >= 200 && status < 300
      ? { success: true, data }
      : { success: false, code, error: "Controlled failure" },
});
export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
