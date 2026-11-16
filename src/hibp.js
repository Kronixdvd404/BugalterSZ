/*
 * Проверка пароля по базе утечек Have I Been Pwned (k-anonymity): наружу уходят только первые 5 символов SHA-1,
 * сам пароль и его хеш целиком не передаются. Любой сбой сети или таймаут = пароль считается непроверенным (регистрация не блокируется).
 */
async function sha1Hex(s) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** true, если пароль найден в утечках. */
export async function isPwned(password, { timeoutMs = 2000, fetchFn = fetch } = {}) {
  try {
    const hash = await sha1Hex(password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetchFn('https://api.pwnedpasswords.com/range/' + prefix, { headers: { 'Add-Padding': 'true' }, signal: ctl.signal });
      if (!res.ok) return false;
      for (const line of (await res.text()).split('\n')) {
        const [suf, count] = line.trim().split(':');
        if (suf === suffix && Number(count) > 0) return true; // строки с нулём это «паддинг»
      }
      return false;
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    return false;
  }
}
