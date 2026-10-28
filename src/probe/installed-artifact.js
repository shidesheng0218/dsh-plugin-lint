import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ToolError } from '../shared/errors.js';

export function readInstalledArtifact(profileDir, name) {
  if (typeof name !== 'string' || name.includes('..') || name.startsWith('/') || name.startsWith('\\')) {
    throw new ToolError('ARTIFACT_MISSING', 'The installed artifact name is invalid.');
  }
  const path = join(profileDir, 'node_modules', ...name.split('/'));
  try {
    const manifest = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    if (typeof manifest.version !== 'string' || !manifest.version) throw new Error('missing version');
    return { version: manifest.version, path };
  } catch (cause) {
    throw new ToolError('ARTIFACT_MISSING', `The installed manifest for ${name} is missing or unreadable.`, { cause });
  }
}
