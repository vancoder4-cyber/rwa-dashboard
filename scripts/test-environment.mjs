const SAFE_TEST_ENV_KEYS = new Set([
  'CI',
  'COLORTERM',
  'COMSPEC',
  'FORCE_COLOR',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOGNAME',
  'NO_COLOR',
  'NODE_NO_WARNINGS',
  'NODE_OPTIONS',
  'PATH',
  'PATHEXT',
  'SHELL',
  'SYSTEMROOT',
  'TEMP',
  'TERM',
  'TMP',
  'TMPDIR',
  'TZ',
  'USER',
  'WINDIR',
]);

export function createHermeticTestEnvironment(source = process.env) {
  return Object.fromEntries(
    Object.entries(source).filter(([key]) => SAFE_TEST_ENV_KEYS.has(key)),
  );
}
