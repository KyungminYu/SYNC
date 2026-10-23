// Maintenance helper: pin manifests to installed resolutions; run pnpm install afterward.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
for (const directory of [
  '.',
  'apps/web',
  'apps/agent-service',
  'packages/contracts',
  'packages/bindings',
  'packages/test-fixtures',
  'packages/sync-core',
  'spacetimedb',
]) {
  const path = join(directory, 'package.json'),
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  for (const section of ['dependencies', 'devDependencies'])
    for (const [name, version] of Object.entries(manifest[section] ?? {})) {
      if (version.startsWith('workspace:')) continue;
      manifest[section][name] = JSON.parse(
        readFileSync(
          join(directory, 'node_modules', name, 'package.json'),
          'utf8',
        ),
      ).version;
    }
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
}
