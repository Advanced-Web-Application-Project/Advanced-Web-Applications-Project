export function formatScreeningTime(value) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Helsinki",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(value));
}
export function screeningListQuery(form, role, cityId) {
  const query = new URLSearchParams();
  for (const name of ["dateFrom", "dateTo", "cityId", "screenId"]) {
    const value = form.get(name);
    if (typeof value === "string" && value) query.set(name, value);
  }
  if (role === "cashier") query.set("cityId", String(cityId));
  return query;
}
export function validateScreeningList(data) {
  if (
    !data ||
    !Array.isArray(data.screenings) ||
    !Array.isArray(data.cities) ||
    !Array.isArray(data.screens) ||
    !data.filters ||
    !Number.isFinite(Date.parse(data.as_of))
  )
    throw Error("Invalid screening list response");
  return data;
}
