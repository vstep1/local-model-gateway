#!/usr/bin/env node
import { formatDoctor, runDoctor } from './doctor.js';
import { writeDefaultConfig } from './init.js';
import { listRecipes, parseRecipeName, renderRecipe } from './recipes.js';
import { installLaunchdService } from './service.js';
import { startGateway } from '@local-model-gateway/gateway';

function usage(): string {
  return [
    'Usage: local-model-gateway <command>',
    '       local-ai-gateway <command>  # compatibility alias',
    '',
    'Commands:',
    '  init',
    '  doctor',
    '  start',
    '  service install',
    '  recipes list',
    '  recipes show <generic-openai|generic-mcp|hermes>',
  ].join('\n');
}

async function main(argv: string[]): Promise<void> {
  const [command, subcommand, value] = argv;
  if (!command || command === '--help' || command === '-h') {
    console.log(usage());
    return;
  }

  if (command === 'init') {
    const target = await writeDefaultConfig(process.cwd(), argv.includes('--force'));
    console.log(`Wrote ${target}`);
    return;
  }

  if (command === 'doctor') {
    const checks = await runDoctor(process.cwd());
    console.log(formatDoctor(checks));
    if (checks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }

  if (command === 'start') {
    await startGateway();
    return;
  }

  if (command === 'service' && subcommand === 'install') {
    const plist = await installLaunchdService(process.cwd());
    console.log(`Installed and started launchd service: ${plist}`);
    return;
  }

  if (command === 'recipes' && subcommand === 'list') {
    console.log(listRecipes().join('\n'));
    return;
  }

  if (command === 'recipes' && subcommand === 'show' && value) {
    console.log(renderRecipe(parseRecipeName(value)));
    return;
  }

  throw new Error(usage());
}

void main(process.argv.slice(2)).catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
