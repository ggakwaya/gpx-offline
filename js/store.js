// Stockage des parcours dans IndexedDB.

const DB_NAME = 'gpx-offline';
const STORE = 'routes';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const listRoutes = () => run('readonly', s => s.getAll());
export const getRoute = id => run('readonly', s => s.get(id));
export const putRoute = route => run('readwrite', s => s.put(route));
export const deleteRoute = id => run('readwrite', s => s.delete(id));
