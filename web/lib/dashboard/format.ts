export function titleCase(value: string | null | undefined): string {
  return String(value || "unknown")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function interfaceLabel(value: string | null | undefined): string {
  const normalized = String(value || "unknown").toLowerCase();
  const labels: Record<string, string> = {
    api: "API",
    http: "HTTP",
    http_headers: "HTTP headers",
    http_html: "HTML",
    http_json: "HTTP JSON",
    mcp: "MCP",
    sdk: "SDK",
  };
  return labels[normalized] ?? titleCase(value);
}

export function formatDate(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString() : "—";
}

export function relativeDate(value: string | null | undefined): string {
  if (!value) return "—";
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const ranges: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, "second"],
    [60, "minute"],
    [24, "hour"],
    [7, "day"],
    [4.345, "week"],
    [12, "month"],
    [Number.POSITIVE_INFINITY, "year"],
  ];
  let amount = seconds;
  for (const [boundary, unit] of ranges) {
    if (Math.abs(amount) < boundary) {
      return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(
        Math.round(amount),
        unit,
      );
    }
    amount /= boundary;
  }
  return formatDate(value);
}

export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds == null) return "—";
  if (milliseconds < 1000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) {
    return `${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)}s`;
  }
  return `${Math.round(milliseconds / 60_000)}m`;
}

export function isEditor(role: string): boolean {
  return role === "owner" || role === "admin";
}
