export async function copyText(text: string): Promise<boolean> {
  const value: string = typeof text === 'string' ? text.trim() : '';
  if (!value) return false;

  try {
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // ignore
  }

  try {
    const input: HTMLInputElement = document.createElement('input');
    input.value = value;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    return true;
  } catch {
    return false;
  }
}
