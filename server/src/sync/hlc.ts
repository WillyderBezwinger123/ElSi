/** `<wallMs 15 digits>-<counter 5 digits>-<deviceId>`, compared as plain strings. */
export const HLC_RE = /^(\d{15})-(\d{5})-(.+)$/;

/** Maximum allowed clock skew into the future. */
export const MAX_FUTURE_MS = 60_000;

export function isHlc(s: string): boolean {
  return HLC_RE.test(s);
}

/** Clamps the wall-clock part to at most `now + 60 s`, keeping counter and device. */
export function clampHlc(hlc: string, now: number = Date.now()): string {
  const m = HLC_RE.exec(hlc);
  if (!m) throw new Error(`invalid hlc: ${hlc}`);
  const max = now + MAX_FUTURE_MS;
  if (Number(m[1]) <= max) return hlc;
  return `${String(max).padStart(15, '0')}-${m[2]}-${m[3]}`;
}

export function hlcDevice(hlc: string): string | undefined {
  return HLC_RE.exec(hlc)?.[3];
}

/** Stable JSON (sorted object keys), for comparing jsonb content regardless of key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
