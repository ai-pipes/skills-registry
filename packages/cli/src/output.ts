const isControl = (code: number) => code <= 0x1f || (code >= 0x7f && code <= 0x9f);

/**
 * A server- or GitHub-provided string made safe for a terminal: every C0/C1 control character
 * (escape sequences, tabs and newlines inside a field included) becomes `?`.
 */
export function safe(s: string): string {
  let out = '';
  for (const ch of s) out += isControl(ch.charCodeAt(0)) ? '?' : ch;
  return out;
}
