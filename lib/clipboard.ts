/**
 * Copia texto usando la Clipboard API y cae a `document.execCommand('copy')`
 * en navegadores viejos o contextos donde `navigator.clipboard` no está
 * disponible (por ejemplo, iOS/Safari sin permiso o fuera de un gesto).
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === 'undefined') {
    throw new Error('El portapapeles no está disponible');
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.top = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    if (!document.execCommand('copy')) {
      throw new Error('No se pudo copiar el texto');
    }
  } finally {
    document.body.removeChild(textarea);
  }
}
