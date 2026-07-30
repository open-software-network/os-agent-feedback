export async function copyText(value: string): Promise<void> {
  const previousFocus = document.activeElement as HTMLElement | null;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Some browsers drop clipboard permission after an awaited API request.
  }

  const field = document.createElement("textarea");
  field.value = value;
  field.readOnly = true;
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  let copied = false;
  try {
    copied = typeof document.execCommand === "function" && document.execCommand("copy");
  } finally {
    field.remove();
    previousFocus?.focus();
  }
  if (!copied) throw new Error("Could not copy to the clipboard");
}
