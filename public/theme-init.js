/* Применяет сохранённую цветовую тему до отрисовки, чтобы не мигал зелёный фон. */
(function () {
  try {
    var th = localStorage.getItem('bsz_theme');
    if (['acid', 'cherry', 'lemon', 'orange', 'bw'].indexOf(th) > -1) document.documentElement.setAttribute('data-theme', th);
  } catch (_) {}
})();
