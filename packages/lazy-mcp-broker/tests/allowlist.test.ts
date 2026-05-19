import assert from 'node:assert/strict';
import test from 'node:test';
import { isReadOnlyTool, normalizeToolName, resolveToolPolicy } from '../src/allowlist.js';
import { makeToolRecord, summarizeTool } from '../src/catalog.js';
import type { DownstreamServerConfig } from '../src/types.js';

test('normalizes camelCase and punctuation into words', () => {
  assert.equal(normalizeToolName('readGoogleDoc'), 'read_google_doc');
  assert.equal(normalizeToolName('crm_get_schema'), 'crm_get_schema');
});

test('allows read-style tools and rejects mutating tools', () => {
  assert.equal(isReadOnlyTool('google-docs', { name: 'readGoogleDoc' }, {}), true);
  assert.equal(isReadOnlyTool('google-docs', { name: 'editTableCell' }, {}), false);
  assert.equal(isReadOnlyTool('gmail', { name: 'send_message' }, {}), false);
  assert.equal(isReadOnlyTool('meridian-crm', { name: 'crm_record_reply' }, {}), false);
  assert.equal(isReadOnlyTool('meridian-crm', { name: 'crm_get_schema' }, {}), true);
});

test('treats known read-only servers as read-only unless mutation words are present', () => {
  assert.equal(isReadOnlyTool('ahrefs', { name: 'brand_radar_mentions_overview_entities' }, {}), true);
  assert.equal(isReadOnlyTool('pangram', { name: 'pangram_analyze' }, {}), true);
  assert.equal(isReadOnlyTool('pangram', { name: 'delete_saved_score' }, {}), false);
});

test('explicit broker policy can require confirmation and hide metered tools', () => {
  const config: DownstreamServerConfig = {
    broker: {
      tools: {
        pangram_analyze: {
          confirmation: 'required',
          cost: 'metered',
          effect: 'read',
          timeoutMs: 2500,
        },
      },
    },
  };
  const tool = { name: 'pangram_analyze' };
  const policy = resolveToolPolicy('pangram', tool, config);
  assert.deepEqual(policy, {
    confirmation: 'required',
    cost: 'metered',
    effect: 'read',
    timeoutMs: 2500,
  });
  assert.equal(isReadOnlyTool('pangram', tool, config), false);
});

test('search summary omits schema and risk fields', () => {
  const record = makeToolRecord(
    'example',
    {
      name: 'getThing',
      description: 'Get a thing.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
    },
    true,
    { confirmation: 'never', cost: 'free', effect: 'read', timeoutMs: 1000 },
  );
  const summary = summarizeTool(record);
  assert.deepEqual(Object.keys(summary).sort(), [
    'description',
    'name',
    'parameter_names',
    'server',
    'tool_id',
  ]);
  assert.equal(Object.hasOwn(summary, 'risk_level'), false);
  assert.equal(Object.hasOwn(summary, 'input_schema'), false);
});
