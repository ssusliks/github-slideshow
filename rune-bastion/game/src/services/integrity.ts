import { CONFIG } from '../config';
import { hex, sha256, utf8 } from './hash';
import { integrityPlugin } from './platform';

/**
 * Lightweight "is this a modified build?" check. Two independent signals:
 *  1. Web bundle: the build writes integrity.json (sha256 of every emitted JS/CSS file); at run
 *     time the files are re-hashed and compared.
 *  2. Android: the native AppIntegrity plugin reports the APK signing certificate, compared with
 *     the expected release certificate when one is configured.
 * A positive verdict never blocks single-player progress – it only restricts online features.
 * This raises the bar for casual repacks; it is not (and cannot be) tamper-proof on a rooted device.
 */
export interface IntegrityVerdict { modified: boolean; reason: string }

async function digest(buf: ArrayBuffer): Promise<string> {
  const subtle = (globalThis as any).crypto?.subtle;
  if (subtle) return hex(new Uint8Array(await subtle.digest('SHA-256', buf)));
  return hex(sha256(new Uint8Array(buf)));
}

export async function checkIntegrity(): Promise<IntegrityVerdict> {
  if (CONFIG.dev) return { modified: false, reason: 'dev build' };
  try {
    const res = await fetch('./integrity.json', { cache: 'no-store' });
    if (res.ok) {
      const manifest: Record<string, string> = await res.json();
      for (const file of Object.keys(manifest)) {
        const f = await fetch(`./${file}`, { cache: 'no-store' });
        if (!f.ok) return { modified: true, reason: `missing ${file}` };
        if ((await digest(await f.arrayBuffer())) !== manifest[file]) return { modified: true, reason: `hash mismatch ${file}` };
      }
    }
  } catch {
    // Offline or blocked fetch: inconclusive, never treated as tampering.
  }
  const plugin = integrityPlugin();
  if (plugin && CONFIG.signingCertSha256) {
    try {
      const info = await plugin.getInfo();
      if (info.signature.toLowerCase() !== CONFIG.signingCertSha256.toLowerCase()) return { modified: true, reason: 'signature mismatch' };
    } catch { /* inconclusive */ }
  }
  return { modified: false, reason: 'ok' };
}

export const _test = { utf8 };
