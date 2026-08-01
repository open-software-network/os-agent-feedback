export function safeReturnTo(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 4_096 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return null;
  }
  const parsed = new URL(value, "https://epode.invalid");
  if (parsed.origin !== "https://epode.invalid") return null;
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

export function authStartPath(returnTo: unknown): string {
  const safe = safeReturnTo(returnTo);
  if (!safe || safe === "/") return "/auth/start";
  return `/auth/start?return_to=${encodeURIComponent(safe)}`;
}

export function currentReturnTo(location: Pick<Location, "pathname" | "search" | "hash">): string {
  return `${location.pathname}${location.search}${location.hash}`;
}
