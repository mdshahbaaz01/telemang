/**
 * Copy text to the clipboard using the modern async Clipboard API when
 * available, falling back to the legacy `document.execCommand('copy')`
 * path for older browsers, insecure contexts (http://), and embedded
 * webviews that don't expose `navigator.clipboard.writeText`.
 *
 * Returns `true` on success so callers can decide whether to toast.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    if (
      typeof navigator !== "undefined" &&
      navigator.clipboard &&
      typeof navigator.clipboard.writeText === "function" &&
      (window.isSecureContext ?? true)
    ) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to legacy path
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Convenience: copy + show a sonner toast. Import `toast` at call site
 * to avoid pulling sonner into non-UI code paths that use copyToClipboard.
 */
export async function copyWithToast(
  text: string,
  toast: { success: (m: string) => void; error: (m: string) => void },
  successMessage = "Link copied",
  errorMessage = "Failed to copy",
): Promise<boolean> {
  const ok = await copyToClipboard(text);
  if (ok) toast.success(successMessage);
  else toast.error(errorMessage);
  return ok;
}