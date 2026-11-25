import { browserEngine } from './browser.js';
import { nativeEngine } from './native.js';

export const ENGINES = [browserEngine, nativeEngine];

export function getEngine(id) {
  return ENGINES.find((e) => e.id === id) || null;
}

/** المحركات المتاحة دلوقتي ومين فيهم يقدر يحمّل العنصر ده */
export async function engineStatus() {
  const out = [];
  for (const e of ENGINES) {
    out.push({ id: e.id, label: e.label, available: await e.available() });
  }
  return out;
}
