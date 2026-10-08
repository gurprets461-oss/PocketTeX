// "About & storage" dialog: versions, offline state, storage and licences.
import { h, formatBytes } from './dom.ts';
import { infoDialog } from './dialogs.ts';
import { texliveMeta } from '../engine/engine.ts';
import { offlineStatus, requestPersistence } from '../offline.ts';
import { texliveEndpoint } from '../config.ts';

export async function showAbout(): Promise<void> {
  const [meta, status] = await Promise.all([texliveMeta().catch(() => null), offlineStatus()]);
  const row = (k: string, v: string | HTMLElement) => h('tr', {}, h('th', {}, k), h('td', {}, v));
  const persistBtn =
    status.persisted === false
      ? h(
          'button',
          {
            type: 'button',
            class: 'btn small',
            onclick: async () => {
              const ok = await requestPersistence();
              persistBtn!.replaceWith(ok ? 'yes' : 'not granted by the browser');
            },
          },
          'Request',
        )
      : null;
  const body = h(
    'div',
    { class: 'about' },
    h('table', { class: 'kv' },
      row('Engine', meta ? meta.engine : 'unknown'),
      row('TeX Live', meta ? meta.texlive : 'unknown'),
      row('Bundled', meta ? `${meta.bundle.files} files (${formatBytes(meta.bundle.gzBytes)} download)` : '-'),
      row('On demand', meta ? `${meta.tree.files.toLocaleString()} files from ${texliveEndpoint()}` : '-'),
      row('Offline', status.ready ? 'ready (app + engine cached)' : status.supported ? 'not yet (reload once online)' : 'unsupported in this browser'),
      row('Persistent storage', persistBtn || (status.persisted === null ? 'unknown' : status.persisted ? 'yes' : 'no')),
      row('Storage used', status.usage !== null ? `${formatBytes(status.usage)}${status.quota ? ' of ' + formatBytes(status.quota) : ''}` : 'unknown'),
    ),
    h(
      'p',
      { class: 'hint' },
      'PocketTeX runs pdfTeX (SwiftLaTeX build) in WebAssembly entirely on this device. Projects are stored in this browser only: export a .zip to back them up. ',
      'Free software under the GNU AGPL-3.0. Source: ',
      h('a', { href: 'https://github.com/gurprets461-oss/PocketTeX', target: '_blank', rel: 'noopener' }, 'PocketTeX'),
      ', engine: ',
      h('a', { href: 'https://github.com/SwiftLaTeX/SwiftLaTeX', target: '_blank', rel: 'noopener' }, 'SwiftLaTeX'),
      '. TeX Live packages are under their own (free) licences.',
    ),
  );
  infoDialog('PocketTeX', body);
}
