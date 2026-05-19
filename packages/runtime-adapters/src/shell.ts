export interface ShellServiceCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export function renderShellCommand(command: ShellServiceCommand): string {
  const envPrefix = Object.entries(command.env ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${quote(key)}=${quote(value)}`)
    .join(' ');
  const argv = [command.command, ...command.args].map(quote).join(' ');
  return [envPrefix, argv].filter(Boolean).join(' ');
}

function quote(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
