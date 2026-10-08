// Deployment configuration.
//
// TEXLIVE_ENDPOINT is the single switch for where on-demand TeX Live package
// files come from. It points at a directory containing `manifest.json` plus the
// files it lists (the `tree/` output of `npm run build:texlive`). The default is
// this site's own copy; set VITE_TEXLIVE_ENDPOINT at build time to use a
// self-hosted mirror (it must send CORS headers if on another origin).
declare const __TEXLIVE_ENDPOINT__: string;

/** Absolute URL of the app root (honours the GitHub Pages base path). */
export function appBaseUrl(): string {
  return new URL(import.meta.env.BASE_URL, location.href).href;
}

/** Precached engine assets: format, bundle and texlive.json. */
export function texliveBaseUrl(): string {
  return new URL('texlive/', appBaseUrl()).href;
}

export function texliveEndpoint(): string {
  const url = new URL(__TEXLIVE_ENDPOINT__, appBaseUrl()).href;
  return url.endsWith('/') ? url : url + '/';
}
