// Single-quote a string for safe interpolation into a remote shell command.
// Wraps in single quotes and escapes any embedded single quote as '\'' .
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
