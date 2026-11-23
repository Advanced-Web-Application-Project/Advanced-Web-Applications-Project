const deliveredPaths = new Set(["/screenings"]);
export function safeReturnPath(value) {
  return typeof value === "string" && deliveredPaths.has(value)
    ? value
    : "/screenings";
}
