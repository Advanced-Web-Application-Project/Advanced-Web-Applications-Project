const validId = (value) =>
  /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 2147483647;
export function safeReturnPath(value) {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  )
    return "/screenings";
  try {
    const url = new URL(value, "http://rio.invalid");
    const match = /^\/screenings\/(\d+)$/.exec(url.pathname);
    if (
      url.hash ||
      (url.pathname !== "/screenings" && (!match || !validId(match[1])))
    )
      return "/screenings";
    const seen = new Set();
    for (const [key, item] of url.searchParams) {
      if (seen.has(key)) return "/screenings";
      seen.add(key);
      if (
        ["cityId", "screenId"].includes(key)
          ? !validId(item)
          : ["dateFrom", "dateTo"].includes(key)
            ? !/^[1-9]\d{3}-\d{2}-\d{2}$/.test(item)
            : true
      )
        return "/screenings";
    }
    return url.pathname + url.search;
  } catch {
    return "/screenings";
  }
}
