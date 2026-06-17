import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gatewayLaunchdLabel, renderLaunchdPlist, renderShellCommand, runtimeLaunchdLabel } from '../src/index.js';

describe('launchd adapter', () => {
  it('uses public labels without personal prefixes', () => {
    assert.equal(gatewayLaunchdLabel(), 'ai.local.gateway');
    assert.equal(runtimeLaunchdLabel('Qwen 3 32B'), 'ai.local.runtime.qwen-3-32b');
  });

  it('renders plist content without com.vs or hardcoded user paths', () => {
    const plist = renderLaunchdPlist({
      label: gatewayLaunchdLabel(),
      programArguments: ['/usr/local/bin/node', '/opt/local-model-gateway/dist/index.js'],
      workingDirectory: '/opt/local-model-gateway',
    });
    assert.match(plist, /ai\.local\.gateway/);
    assert.doesNotMatch(plist, /com\.vs/);
    assert.doesNotMatch(plist, /\/Users\/vs/);
  });

  it('escapes optional plist fields and can disable keepalive/run-at-load', () => {
    const plist = renderLaunchdPlist({
      environment: {
        B_VALUE: 'two < three',
        A_VALUE: 'one & done',
      },
      keepAlive: false,
      label: runtimeLaunchdLabel('###'),
      programArguments: ['/bin/echo', 'hello > world'],
      runAtLoad: false,
      standardErrorPath: '/tmp/runtime.err',
      standardOutPath: '/tmp/runtime.out',
      workingDirectory: '/tmp/work',
    });

    assert.match(plist, /ai\.local\.runtime\.model/);
    assert.match(plist, /<false\/>/);
    assert.match(plist, /one &amp; done/);
    assert.match(plist, /two &lt; three/);
    assert.ok(plist.indexOf('A_VALUE') < plist.indexOf('B_VALUE'));
    assert.match(plist, /StandardOutPath/);
    assert.match(plist, /StandardErrorPath/);
  });
});

describe('shell adapter', () => {
  it('renders shell commands with sorted environment and safe quoting', () => {
    assert.equal(
      renderShellCommand({
        args: ['plain', 'has space', "can't"],
        command: '/bin/echo',
        env: {
          Z_VALUE: 'last value',
          A_VALUE: 'first',
        },
      }),
      "A_VALUE=first Z_VALUE='last value' /bin/echo plain 'has space' 'can'\\''t'",
    );
  });

  it('omits an empty environment prefix', () => {
    assert.equal(
      renderShellCommand({
        args: ['start'],
        command: './runtime-adapters/qwen.sh',
      }),
      './runtime-adapters/qwen.sh start',
    );
  });
});
