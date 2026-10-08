import './styles.css';
import { ProjectList } from './ui/projectList.ts';
import { Workspace } from './ui/workspace.ts';
import { engine } from './engine/engine.ts';
import { registerServiceWorker, waitForServiceWorker } from './offline.ts';

registerServiceWorker();
// Let the engine's first downloads go through the service worker so they are
// cached for offline use (falls back to plain network after a timeout).
engine.beforeStart = async () => {
  await waitForServiceWorker(45000);
};

const app = document.getElementById('app')!;
const home = new ProjectList({ open: (id) => go(`#/p/${id}`) });
const workspace = new Workspace({ home: () => go('#/') });

function go(hash: string) {
  if (location.hash !== hash) location.hash = hash;
  else void route();
}

async function route() {
  const m = /^#\/p\/([\w-]+)/.exec(location.hash);
  if (m) {
    if (await workspace.open(m[1])) {
      if (!workspace.root.isConnected) app.replaceChildren(workspace.root);
      return;
    }
    history.replaceState(null, '', '#/');
  }
  await home.render();
  app.replaceChildren(home.root);
}

window.addEventListener('hashchange', () => void route());
void route();

// Track the visual viewport so the editor and its accessory bar sit right above
// the on-screen keyboard (iOS Safari does not resize the layout viewport).
const vv = window.visualViewport;
if (vv) {
  // Height with the keyboard closed, per width (i.e. per orientation). Chrome on
  // Android shrinks the layout viewport too, so compare against this baseline.
  const fullHeight = new Map<number, number>();
  const update = () => {
    const root = document.documentElement;
    root.style.setProperty('--app-height', `${vv.height}px`);
    root.style.setProperty('--app-top', `${vv.offsetTop}px`);
    const w = Math.round(vv.width);
    const full = Math.max(fullHeight.get(w) || 0, vv.height);
    fullHeight.set(w, full);
    root.classList.toggle('keyboard-open', full - vv.height > 150);
  };
  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  update();
}
