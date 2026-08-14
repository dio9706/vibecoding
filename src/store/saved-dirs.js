/** web 端常用工作目录（最多 20） */
import { readJson, updateJson } from './index.js';

const FILE = 'saved-dirs.json';

export function getSavedDirs() {
  return readJson(FILE, []);
}

export function addSavedDir(p) {
  return updateJson(FILE, [], (list) => [p, ...list.filter((d) => d !== p)].slice(0, 20));
}

export function removeSavedDir(p) {
  return updateJson(FILE, [], (list) => list.filter((d) => d !== p));
}
