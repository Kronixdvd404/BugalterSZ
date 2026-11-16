/*
 * Политика паролей по NIST SP 800-63B: длина важнее «сложности». Без обязательных цифр и спецсимволов,
 * зато от 10 символов, без слишком простых и без своего ника. Проверка по базам утечек делается отдельно (hibp.js).
 */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 128;

// Самые частые пароли длиной от 10 символов (короче всё равно не пройдут по длине) и частые клавиатурные последовательности.
const COMMON = new Set([
  '1234567890', '0123456789', '0987654321', '1234567891', '12345678910', '1q2w3e4r5t', '1q2w3e4r5t6y', '1qaz2wsx3edc',
  'qwertyuiop', 'qwerty1234', 'qwerty12345', 'qwertyuiop1', 'asdfghjkl1', 'asdfghjkl;', 'zxcvbnm123', 'qazwsxedcrfv', 'qazwsxedc1',
  'йцукенгшщз', 'йцукен1234', 'фывапролдж', 'password12', 'password123', 'password1234', 'passw0rd123', 'iloveyou12', 'iloveyou123',
  'stalcraft1', 'stalcraft12', 'stalcraft123', 'stalkerstalker', 'bugaltersz', 'bugaltersz1', 'bugaltersz123', 'kronix4040', 'ghbdtn1234', 'ghbdtnghbdtn'
]);
// Частые основы: пароль вида «основа + цифры/символы» считается простым.
const COMMON_BASES = new Set(['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'iloveyou', 'letmein', 'welcome', 'monkey', 'dragon', 'football', 'baseball', 'stalcraft', 'stalker', 'stalzone', 'bugaltersz', 'admin', 'administrator', 'ghbdtn', 'йцукен', 'пароль', 'привет']);

/** Возвращает текст ошибки (по-русски, он есть в i18n.js) или null, если пароль подходит. */
export function passwordProblem(password, nick = '') {
  const p = String(password);
  if (p.length < PASSWORD_MIN) return 'Пароль должен быть не короче 10 символов';
  if (p.length > PASSWORD_MAX) return 'Пароль слишком длинный';
  const low = p.toLowerCase();
  const n = String(nick).toLowerCase();
  if (n.length >= 4 && low.includes(n)) return 'Пароль не должен содержать ваш ник';
  if (n && low === n) return 'Пароль не должен содержать ваш ник';
  const base = low.replace(/[^a-zа-яё]+$/i, '');
  if (COMMON.has(low) || COMMON_BASES.has(base) || new Set(low).size < 4) return 'Пароль слишком простой, придумайте другой';
  return null;
}
