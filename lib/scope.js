export function candidateScopeValid(paths, existingTestChanges, allowDist) {
  return paths.some(path => path.startsWith('src/')) &&
    paths.every(path => /^(?:src|tests)\/[\w./-]+\.ts$/.test(path) ||
      (allowDist && /^dist\/index\.(?:js|js\.map|d\.ts)$/.test(path))) &&
    !existingTestChanges.length;
}

export const existingTestDiff = ['diff', '--no-renames', '--diff-filter=DMRTUXB',
  '--name-only', '-z', 'HEAD', '--', 'tests/'];
