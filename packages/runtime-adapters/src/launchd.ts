export interface LaunchdServiceDefinition {
  environment?: Record<string, string>;
  keepAlive?: boolean;
  label: string;
  programArguments: string[];
  runAtLoad?: boolean;
  standardErrorPath?: string;
  standardOutPath?: string;
  workingDirectory: string;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function envXml(environment: Record<string, string>): string {
  const entries = Object.entries(environment).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return '';
  const body = entries
    .map(([key, value]) => `    <key>${xmlEscape(key)}</key>\n    <string>${xmlEscape(value)}</string>`)
    .join('\n');
  return `\n  <key>EnvironmentVariables</key>\n  <dict>\n${body}\n  </dict>`;
}

export function renderLaunchdPlist(definition: LaunchdServiceDefinition): string {
  const args = definition.programArguments
    .map((arg) => `    <string>${xmlEscape(arg)}</string>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(definition.label)}</string>

  <key>ProgramArguments</key>
  <array>
${args}
  </array>

  <key>WorkingDirectory</key>
  <string>${xmlEscape(definition.workingDirectory)}</string>

  <key>RunAtLoad</key>
  <${definition.runAtLoad === false ? 'false' : 'true'}/>
  <key>KeepAlive</key>
  <${definition.keepAlive === false ? 'false' : 'true'}/>
${definition.standardOutPath ? `
  <key>StandardOutPath</key>
  <string>${xmlEscape(definition.standardOutPath)}</string>` : ''}
${definition.standardErrorPath ? `
  <key>StandardErrorPath</key>
  <string>${xmlEscape(definition.standardErrorPath)}</string>` : ''}
${envXml(definition.environment ?? {})}
</dict>
</plist>
`;
}

export function gatewayLaunchdLabel(name = 'gateway'): string {
  return `ai.local.${name}`;
}

export function runtimeLaunchdLabel(alias: string): string {
  const safeAlias = alias.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '');
  return `ai.local.runtime.${safeAlias || 'model'}`;
}
