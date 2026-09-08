// Copying a short string to the clipboard, from a page that is not always on
// a secure origin.
//
// navigator.clipboard is undefined on plain http, and this app is reached that
// way routinely — the kitchen tablet opens it on the LAN IP, not the https
// tailnet name. So the textarea/execCommand path is not a legacy fallback
// here, it is the branch that actually runs on the device the copy button
// exists for. execCommand is deprecated and still the only thing that works
// there.
//
// Returns whether it worked, so the caller can say "Copied" only when it was.
export const copyToClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    // Fixed and invisible, but NOT display:none or hidden — a textarea the
    // browser does not lay out cannot be selected, and the copy silently
    // does nothing.
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      // Blocked outright (some locked-down webviews). Reported as a failure
      // rather than a silent success, so the button does not claim it copied.
      ok = false;
    }
    document.body.removeChild(area);
    return ok;
  }
};
