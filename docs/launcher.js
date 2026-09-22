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
function downloadProgress(received, total) {
  const percent = Math.floor(received / total * 100);
  progress.value = received / total * 90;
  status.textContent = `正在下载资源… ${percent}%（${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB）`;
}
async function downloadPart(part, buffer, offset) {
  if (!Number.isSafeInteger(part.bytes) || part.bytes <= 0 || offset + part.bytes > buffer.length) {
    throw new Error('资源清单大小不正确');
  }
  const response = await checkedFetch(part.file);
  let received = 0;
  const append = bytes => {
    if (received + bytes.length > part.bytes) throw new Error('资源分块大小不正确');
    buffer.set(bytes, offset + received);
    received += bytes.length;
    downloadProgress(offset + received, buffer.length);
  };
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    try {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        append(value);
      }
    } catch (error) {
      try { await reader.cancel(); } catch (_) { /* Preserve the download error. */ }
      throw error;
    } finally { reader.releaseLock(); }
  } else {
    append(new Uint8Array(await response.arrayBuffer()));
  }
  if (received !== part.bytes) throw new Error('资源下载不完整，请重试');
  const bytes = buffer.subarray(offset, offset + received);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(x => x.toString(16).padStart(2, '0')).join('');
  if (digest !== part.sha256) throw new Error('资源校验失败，请刷新重新下载');
  return received;
}
launch.onclick = async () => {
  if (busy) return; busy = true; launch.disabled = reset.disabled = true;
  try {
    // Loading or updating the game must never erase player saves.
    const manifest = await (await checkedFetch('release.json')).json();
    const engine = new Engine({executable: manifest.executable, canvas,
      canvasResizePolicy: 2, focusCanvas: true, experimentalVK: true,
      fileSizes: manifest.fileSizes, persistentPaths: ['/userfs'],
      onPrint: (...args) => console.log(...args), onPrintError: (...args) => console.error(...args)});
    window.bakeryEngine = engine;
    status.textContent = '正在准备面包屋…';
    const buffer = new Uint8Array(manifest.packBytes);
    let offset = 0;
    downloadProgress(0, manifest.packBytes);
    for (const part of manifest.parts) offset += await downloadPart(part, buffer, offset);
    if (offset !== manifest.packBytes) throw new Error('资源清单总大小不正确');
    status.textContent = '资源下载完成，正在启动引擎…';
    await engine.init(manifest.executable);
    progress.value = 94;
    status.textContent = '正在载入面包屋…';
    await engine.preloadFile(buffer.buffer, manifest.executable + '.pck');
    await engine.start({args: ['--main-pack', manifest.executable + '.pck']});
    progress.value = 100; gate.hidden = true; canvas.focus();
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
