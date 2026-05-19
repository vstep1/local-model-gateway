export type RecipeName = 'generic-openai' | 'generic-mcp' | 'hermes';

const OPENAI_BASE = 'http://127.0.0.1:8787/v1';
const MCP_URL = 'http://127.0.0.1:8787/mcp';

export function listRecipes(): RecipeName[] {
  return ['generic-openai', 'generic-mcp', 'hermes'];
}

export function renderRecipe(name: RecipeName): string {
  switch (name) {
    case 'generic-openai':
      return [
        'OpenAI-compatible client',
        '',
        `base_url: ${OPENAI_BASE}`,
        'api_key: local-ai-gateway',
        'model: <one of GET /v1/models>',
        '',
        'Example curl:',
        `curl ${OPENAI_BASE}/chat/completions \\`,
        "  -H 'Content-Type: application/json' \\",
        "  -d '{\"model\":\"qwen3-32b\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}'",
      ].join('\n');
    case 'generic-mcp':
      return [
        'MCP Streamable HTTP client',
        '',
        `url: ${MCP_URL}`,
        'transport: streamable-http',
        '',
        'Useful setup tools:',
        '- gateway_status',
        '- list_runtime_models',
        '- recommend_local_profile',
        '- generate_client_config',
        '- validate_client_config',
      ].join('\n');
    case 'hermes':
      return [
        'Hermes profile snippet',
        '',
        'provider:',
        '  local-ai-gateway:',
        '    type: custom',
        `    base_url: ${OPENAI_BASE}`,
        '    api_mode: chat_completions',
        '    api_key: local-ai-gateway',
        '',
        'mcp_servers:',
        '  local-ai-gateway:',
        '    url: http://127.0.0.1:8787/mcp',
        '    transport: httpStream',
        '',
        'Use the model aliases returned by `curl http://127.0.0.1:8787/v1/models`.',
      ].join('\n');
  }
}

export function parseRecipeName(value: string): RecipeName {
  if (listRecipes().includes(value as RecipeName)) return value as RecipeName;
  throw new Error(`Unknown recipe "${value}". Available recipes: ${listRecipes().join(', ')}`);
}
