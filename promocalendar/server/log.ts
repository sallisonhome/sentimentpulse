export function log(message: string): void {
  const ts = new Date().toISOString();
  // eslint-disable-next-line no-console
  console.log(`[${ts}] [partnerships] ${message}`);
}
