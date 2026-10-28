import { copyFileSync, cpSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ToolError } from '../../shared/errors.js';

export async function materializeArtifact(artifact, sourceDir) {
  const sourcePath = artifact?.tarballPath || artifact?.path;
  if (!sourcePath) throw new ToolError('ARTIFACT_MISSING', 'The artifact has no local file or directory to materialize.');
  let stat;
  try {
    stat = statSync(sourcePath);
  } catch (cause) {
    throw new ToolError('ARTIFACT_MISSING', 'The artifact source is missing or unreadable.', { cause });
  }
  const name = stat.isDirectory()
    ? String(artifact.name || basename(sourcePath)).replace(/[^A-Za-z0-9._-]/g, '_')
    : basename(sourcePath);
  const hostPath = join(sourceDir, name);
  if (stat.isDirectory()) cpSync(sourcePath, hostPath, { recursive: true, force: true });
  else copyFileSync(sourcePath, hostPath);
  const containerPath = `/source/${name}`;
  return { ...artifact, hostPath, containerPath, installTarget: containerPath };
}
