'use strict';
const canvas = document.querySelector('canvas');
const status = document.querySelector('#status');
const progress = document.querySelector('progress');
const launch = document.querySelector('#launch');
const reset = document.querySelector('#reset');
const gate = document.querySelector('#gate');
const revision = 'puppy-bakery-web-20260909';
const saveNames = new Set(['bakery_game.json', 'bakery_web_20260909.json']);
let busy = false;
function showError(error) {
  console.error(error); status.textContent = '未能启动：' + error.message + '。请刷新后重试。';
  gate.hidden = false; launch.disabled = false; reset.disabled = false; busy = false;
}
async function clearBakeryData() {
  // Godot mounts /userfs in IndexedDB. Delete only this game's known save files.
  const databases = await indexedDB.databases();
  for (const info of databases.filter(x => x.name === '/userfs')) {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(info.name);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('FILE_DATA')) { db.close(); resolve(); return; }
        const tx = db.transaction('FILE_DATA', 'readwrite');
        const cursor = tx.objectStore('FILE_DATA').openCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result; if (!entry) return;
          if (saveNames.has(String(entry.key).split('/').pop())) entry.delete();
          entry.continue();
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
        tx.onabort = () => { db.close(); reject(tx.error || new Error('存档清理被中断')); };
      };
    });
  }
  if ('caches' in window) {
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        const url = new URL(request.url);
        if (url.origin === location.origin && url.pathname.includes('/puppy-bakery')) await cache.delete(request);
      }
    }
  }
  if ('serviceWorker' in navigator) {
    for (const registration of await navigator.serviceWorker.getRegistrations()) {
      const url = new URL(registration.scope);
      if (url.origin === location.origin && url.pathname.includes('/puppy-bakery')) await registration.unregister();
    }
  }
  localStorage.setItem(revision, 'ready');
}
async function checkedFetch(path) {
  const response = await fetch(path, {cache: 'no-store'});
  if (!response.ok) throw new Error(`下载失败 (${response.status})`);
  return response;
}
launch.onclick = async () => {
  if (busy) return; busy = true; launch.disabled = reset.disabled = true;
  try {
    if (localStorage.getItem(revision) !== 'ready') await clearBakeryData();
    const manifest = await (await checkedFetch('release.json')).json();
    const engine = new Engine({executable: manifest.executable, canvas,
      canvasResizePolicy: 2, focusCanvas: true, experimentalVK: true,
      fileSizes: manifest.fileSizes, persistentPaths: ['/userfs'],
      onPrint: (...args) => console.log(...args), onPrintError: (...args) => console.error(...args)});
    window.bakeryEngine = engine;
    status.textContent = '正在准备面包屋…';
    const buffer = new Uint8Array(manifest.packBytes);
    let offset = 0;
    for (const part of manifest.parts) {
      const bytes = new Uint8Array(await (await checkedFetch(part.file)).arrayBuffer());
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
      if (bytes.length !== part.bytes || digest !== part.sha256) throw new Error('资源校验失败，请刷新重新下载');
      buffer.set(bytes, offset); offset += bytes.length;
      progress.value = offset / manifest.packBytes * 90;
      status.textContent = `正在准备面包屋… ${Math.round(offset / manifest.packBytes * 100)}%`;
    }
    await engine.init(manifest.executable);
    await engine.preloadFile(buffer.buffer, manifest.executable + '.pck');
    await engine.start({args: ['--main-pack', manifest.executable + '.pck']});
    progress.value = 100; gate.hidden = true; canvas.focus();
    document.querySelector('#restart-link').hidden = false;
  } catch (error) { showError(error); }
};
reset.onclick = async () => {
  if (busy) return;
  if (!confirm('清除面包屋试玩进度，从选店长重新开始？')) return;
  busy = true; launch.disabled = reset.disabled = true;
  try { await clearBakeryData(); status.textContent = '试玩进度已清除，可以从头开始。'; }
  catch (error) { showError(error); }
  finally { busy = false; launch.disabled = reset.disabled = false; }
};
// Leave the running engine before showing reset, so it cannot write an old save back.
document.querySelector('#restart-link').onclick = () => location.reload();
