import { pathToFileURL } from 'node:url';
import { startGateway } from './server.js';

export { startGateway } from './server.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void startGateway().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error('[local-ai-gateway] fatal bootstrap error:', message);
    process.exit(1);
  });
}
