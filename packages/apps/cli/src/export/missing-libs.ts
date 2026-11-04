/**
 * Turns the dynamic loader's "error while loading shared libraries" into an install
 * hint. Typical on a bare Linux server running the downloaded headless shell: the
 * binary is fine, the distro just lacks the X11/NSS/GBM libraries Chromium links.
 * The loader reports only the FIRST missing library, so the hint installs the whole
 * set headless Chromium needs rather than sending the user round once per library.
 */

const LOADER_RE = /error while loading shared libraries: ([^\s:]+): cannot open shared object file/

/** The soname the loader could not find, or null when that is not why it failed. */
export function missingSharedLibrary(stderr: string): string | null {
  return LOADER_RE.exec(stderr)?.[1] ?? null
}

/** Debian/Ubuntu package per soname prefix (the part before `.so`). */
const DEBIAN_PACKAGE: Record<string, string> = {
  libnss3: 'libnss3',
  libnssutil3: 'libnss3',
  libsmime3: 'libnss3',
  libnspr4: 'libnspr4',
  libplc4: 'libnspr4',
  libplds4: 'libnspr4',
  'libatk-1.0': 'libatk1.0-0',
  'libatk-bridge-2.0': 'libatk-bridge2.0-0',
  libatspi: 'libatspi2.0-0',
  libcups: 'libcups2',
  libdrm: 'libdrm2',
  libgbm: 'libgbm1',
  libxkbcommon: 'libxkbcommon0',
  libXcomposite: 'libxcomposite1',
  libXdamage: 'libxdamage1',
  libXfixes: 'libxfixes3',
  libXrandr: 'libxrandr2',
  libXext: 'libxext6',
  libX11: 'libx11-6',
  libxcb: 'libxcb1',
  'libpango-1.0': 'libpango-1.0-0',
  libcairo: 'libcairo2',
  'libglib-2.0': 'libglib2.0-0',
  'libgobject-2.0': 'libglib2.0-0',
  'libgio-2.0': 'libglib2.0-0',
  'libdbus-1': 'libdbus-1-3',
  libexpat: 'libexpat1',
  libasound: 'libasound2',
  'libwayland-client': 'libwayland-client0'
}

/**
 * What headless Chromium links on Debian/Ubuntu, minus what every base image has.
 * `libasound2` is left out on purpose: Ubuntu 24.04 renamed it (libasound2t64) and
 * apt refuses the old name; it is added only when it is the one reported missing.
 */
const HEADLESS_CHROMIUM_DEBIAN = [
  'libnss3',
  'libnspr4',
  'libatk1.0-0',
  'libatk-bridge2.0-0',
  'libcups2',
  'libdrm2',
  'libgbm1',
  'libxkbcommon0',
  'libxcomposite1',
  'libxdamage1',
  'libxfixes3',
  'libxrandr2',
  'libpango-1.0-0',
  'libcairo2'
]

export function missingLibraryHint(soname: string): string {
  const pkg = DEBIAN_PACKAGE[soname.replace(/\.so(\.\d+)*$/, '')]
  const pkgs =
    pkg && !HEADLESS_CHROMIUM_DEBIAN.includes(pkg)
      ? [...HEADLESS_CHROMIUM_DEBIAN, pkg]
      : HEADLESS_CHROMIUM_DEBIAN
  const provider = pkg ? ` (package ${pkg})` : ''
  return [
    `The browser could not start: the system library ${soname} is missing${provider}.`,
    'On Debian/Ubuntu, install the libraries headless Chromium needs:',
    `  sudo apt-get install -y ${pkgs.join(' ')}`,
    `Elsewhere, install the package that provides ${soname}, or pass --browser <path>.`
  ].join('\n')
}
