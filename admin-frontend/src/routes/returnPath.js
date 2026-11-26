const deliveredPaths = new Set(["/screenings", "/prices"]);
export function safeReturnPath(value) {
  return typeof value === "string" && deliveredPaths.has(value)
    ? value
    : "/screenings";
}
