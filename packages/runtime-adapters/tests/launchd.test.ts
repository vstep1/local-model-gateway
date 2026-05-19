import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gatewayLaunchdLabel, renderLaunchdPlist, runtimeLaunchdLabel } from '../src/index.js';

describe('launchd adapter', () => {
  it('uses public labels without personal prefixes', () => {
    assert.equal(gatewayLaunchdLabel(), 'ai.local.gateway');
    assert.equal(runtimeLaunchdLabel('Qwen 3 32B'), 'ai.local.runtime.qwen-3-32b');
  });

  it('renders plist content without com.vs or hardcoded user paths', () => {
    const plist = renderLaunchdPlist({
      label: gatewayLaunchdLabel(),
      programArguments: ['/usr/local/bin/node', '/opt/local-ai-gateway/dist/index.js'],
      workingDirectory: '/opt/local-ai-gateway',
    });
    assert.match(plist, /ai\.local\.gateway/);
    assert.doesNotMatch(plist, /com\.vs/);
    assert.doesNotMatch(plist, /\/Users\/vs/);
  });
});
