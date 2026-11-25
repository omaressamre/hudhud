// اسم ملف التسطيب حسب نظام التشغيل (للرسايل اللي بتظهر للمستخدم)
let os = 'win';
const ready = (async () => {
  try { os = (await chrome.runtime.getPlatformInfo()).os; } catch {}
})();

export function platformReady() { return ready; }
export function currentOs() { return os; }
export function installer() {
  if (os === 'mac') return 'install.command';
  if (os === 'win') return 'install.bat';
  return 'install.sh';
}
