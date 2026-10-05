/** A quoted Lucene literal must escape backslashes before they can escape its closing quote. */
export function quoteLiteral(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`
}
