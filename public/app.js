(() => {
  'use strict';

  const { parseMoney, formatMoney, formatSigned, formatShort } = window.Money;
  const $app = document.getElementById('app');

  /* ===================== утилиты ===================== */

  /** h('div', {class:'x', onclick}, 'text', child) — без innerHTML, весь текст экранируется. */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    add(el, kids);
    return el;
  }
  function add(el, kids) {
    for (const k of kids.flat(Infinity)) {
      if (k === null || k === undefined || k === false) continue;
      el.append(k.nodeType ? k : document.createTextNode(String(k)));
    }
  }

  const ICONS = {
    auction: '<path d="M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    ledger: '<rect x="3" y="6" width="18" height="13" rx="3"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1"/><path d="M7 3.5h10"/>',
    notes: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12h7M9 16h5"/>',
    search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.4-4.4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    back: '<path d="M15 5l-7 7 7 7"/>',
    chev: '<path d="M9 5l7 7-7 7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    logout: '<path d="M10 4H5v16h5M15 8l4 4-4 4M19 12H9"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
    bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>'
  };
  function icon(name, cls) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '1.8');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    s.innerHTML = ICONS[name]; // только статичные строки из ICONS
    return s;
  }

  const rub = (n) => formatMoney(n) + ' ₽';
  const pad = (n) => String(n).padStart(2, '0');
  const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

  function ago(ts) {
    if (!ts) return '';
    const s = Math.max(0, (Date.now() - ts) / 1000);
    if (s < 45) return 'только что';
    if (s < 3600) return Math.round(s / 60) + ' мин назад';
    if (s < 86400) return Math.floor(s / 3600) + ' ч назад';
    return Math.floor(s / 86400) + ' д назад';
  }
  const dayKey = (ts) => {
    const d = new Date(ts);
    return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
  };
  function dayLabel(ts) {
    const d = new Date(ts);
    const today = new Date();
    if (dayKey(ts) === dayKey(today)) return 'Сегодня';
    if (dayKey(ts) === dayKey(today.getTime() - 86400000)) return 'Вчера';
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== today.getFullYear() ? ' ' + d.getFullYear() : '');
  }
  const clock = (ts) => {
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  };

  const QLT = [
    ['Обычный', 'var(--q0)'],
    ['Необычный', 'var(--q1)'],
    ['Особый', 'var(--q2)'],
    ['Редкий', 'var(--q3)'],
    ['Исключительный', 'var(--q4)'],
    ['Легендарный', 'var(--q5)']
  ];

  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch('/api' + path, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try {
      data = await res.json();
    } catch (_) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || 'Ошибка ' + res.status);
      err.status = res.status;
      if (res.status === 401 && state.user) {
        state.user = null;
        renderAuth('Сессия закончилась. Войдите снова.');
      }
      throw err;
    }
    return data;
  }

  /** Кнопка с двойным нажатием вместо всплывающего окна подтверждения. */
  function deleteButton(onConfirm, { label = 'Удалить' } = {}) {
    let timer = null;
    const btn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': label });
    const reset = () => {
      btn.className = 'icon-btn';
      btn.replaceChildren(icon('trash'));
      btn.setAttribute('aria-label', label);
    };
    reset();
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!timer) {
        btn.className = 'icon-btn danger-confirm';
        btn.textContent = 'Точно удалить?';
        timer = setTimeout(() => {
          timer = null;
          reset();
        }, 3000);
      } else {
        clearTimeout(timer);
        timer = null;
        reset();
        onConfirm();
      }
    });
    return btn;
  }

  function thumb(src, name, cls) {
    const t = h('div', { class: 'thumb' + (cls ? ' ' + cls : '') });
    const letter = () => t.replaceChildren(String(name || '?').trim().charAt(0).toUpperCase());
    if (src) {
      const img = h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', width: 44, height: 44 });
      img.addEventListener('error', letter);
      t.append(img);
    } else letter();
    return t;
  }

  /* ===================== состояние и роутинг ===================== */

  const state = { user: null, regions: ['ru', 'eu'], demo: false, region: 'all' };
  let cleanups = [];
  const onLeave = (fn) => cleanups.push(fn);
  const interval = (fn, ms) => onLeave(((id) => () => clearInterval(id))(setInterval(fn, ms)));
  function runCleanups() {
    const c = cleanups;
    cleanups = [];
    c.forEach((f) => {
      try {
        f();
      } catch (_) {}
    });
  }

  const TABS = [
    ['auction', 'Аукцион'],
    ['ledger', 'Бухгалтер'],
    ['notes', 'Заметки']
  ];

  function parseHash() {
    const m = location.hash.replace(/^#\/?/, '').split('/');
    const tab = TABS.some((t) => t[0] === m[0]) ? m[0] : 'auction';
    return { tab, id: m[1] || '' };
  }

  let shell = null;
  function renderShell() {
    const tabs = h('nav', { class: 'tabs', 'aria-label': 'Разделы' });
    const ind = h('span', { class: 'tab-ind' });
    tabs.append(ind);
    const buttons = {};
    for (const [key, label] of TABS) {
      const b = h('button', { class: 'tab', type: 'button', onclick: () => (location.hash = '#/' + key) }, icon(key), label);
      buttons[key] = b;
      tabs.append(b);
    }
    const main = h('main', { id: 'view' });
    $app.replaceChildren(
      h(
        'div',
        { class: 'shell' },
        h(
          'header',
          { class: 'topbar' },
          h(
            'div',
            { class: 'topbar-in' },
            h('div', { class: 'logo' }, 'Bugalter', h('b', {}, 'SZ')),
            tabs,
            h(
              'div',
              { class: 'user' },
              h('span', { class: 'user-nick' }, state.user.nick),
              h(
                'button',
                {
                  class: 'icon-btn',
                  type: 'button',
                  title: 'Выйти',
                  'aria-label': 'Выйти',
                  onclick: async () => {
                    try {
                      await api('/auth/logout', { method: 'POST', body: {} });
                    } catch (_) {}
                    state.user = null;
                    runCleanups();
                    location.hash = '';
                    renderAuth();
                  }
                },
                icon('logout')
              )
            )
          )
        ),
        main
      )
    );
    shell = { tabs, ind, buttons, main };
    moveIndicator(false);
  }

  function moveIndicator(animate = true) {
    if (!shell) return;
    const { tab } = parseHash();
    for (const [k, b] of Object.entries(shell.buttons)) {
      if (k === tab) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    const b = shell.buttons[tab];
    const ind = shell.ind;
    if (!animate) ind.style.transition = 'none';
    ind.style.width = b.offsetWidth + 'px';
    ind.style.transform = 'translateX(' + b.offsetLeft + 'px)';
    if (!animate) {
      void ind.offsetWidth;
      ind.style.transition = '';
    }
  }
  window.addEventListener('resize', () => moveIndicator(false));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => moveIndicator(false));

  function route() {
    if (!state.user) return;
    if (!shell || !document.body.contains(shell.main)) renderShell();
    runCleanups();
    moveIndicator(true);
    const { tab, id } = parseHash();
    shell.main.replaceChildren();
    window.scrollTo(0, 0);
    if (tab === 'auction') viewAuction(shell.main);
    else if (tab === 'ledger') viewLedger(shell.main);
    else if (id) viewNote(shell.main, id);
    else viewNotes(shell.main);
  }
  window.addEventListener('hashchange', route);

  /* ===================== вход и регистрация ===================== */

  function renderAuth(message) {
    runCleanups();
    shell = null;
    let mode = 'login';
    const err = h('div', { class: 'auth-err', role: 'alert' }, message || '');
    const nick = h('input', { class: 'input', id: 'nick', autocomplete: 'username', placeholder: 'Например, Stalker_77', maxlength: 20, required: true });
    const pass = h('input', { class: 'input', id: 'pass', type: 'password', autocomplete: 'current-password', placeholder: 'Не короче 6 символов', required: true });
    const submit = h('button', { class: 'btn wide', type: 'submit' }, 'Войти');
    const seg = h('div', { class: 'seg full', role: 'group', 'aria-label': 'Режим' });
    const bLogin = h('button', { type: 'button', 'aria-pressed': 'true', onclick: () => setMode('login') }, 'Вход');
    const bReg = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => setMode('register') }, 'Регистрация');
    seg.append(bLogin, bReg);

    function setMode(m) {
      mode = m;
      bLogin.setAttribute('aria-pressed', String(m === 'login'));
      bReg.setAttribute('aria-pressed', String(m === 'register'));
      submit.textContent = m === 'login' ? 'Войти' : 'Создать аккаунт';
      pass.setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password');
      err.textContent = '';
    }

    const form = h(
      'form',
      {
        class: 'card auth-form',
        onsubmit: async (e) => {
          e.preventDefault();
          err.textContent = '';
          submit.disabled = true;
          try {
            const r = await api('/auth/' + mode, { method: 'POST', body: { nick: nick.value, password: pass.value } });
            state.user = r.user;
            if (location.hash && location.hash !== '#/') route();
            else location.hash = '#/auction';
          } catch (ex) {
            err.textContent = ex.message;
          } finally {
            submit.disabled = false;
          }
        }
      },
      seg,
      h('div', { class: 'field' }, h('label', { for: 'nick' }, 'Ник'), nick),
      h('div', { class: 'field' }, h('label', { for: 'pass' }, 'Пароль'), pass),
      err,
      submit
    );

    $app.replaceChildren(
      h(
        'div',
        { class: 'auth-wrap' },
        h(
          'div',
          { class: 'auth-card' },
          h('div', { class: 'auth-logo' }, h('div', { class: 'logo' }, 'Bugalter', h('b', {}, 'SZ')), h('p', { class: 'sub' }, 'Аукцион, учёт денег и заметки в одном месте')),
          form
        )
      )
    );
    nick.focus();
  }

  /* ===================== вкладка 1: аукцион ===================== */

  function qualityBits(l) {
    const out = [];
    if (l.qlt !== null && l.qlt !== undefined && QLT[l.qlt]) out.push(h('span', { class: 'q', style: { color: QLT[l.qlt][1] } }, QLT[l.qlt][0]));
    // заточка показывается всегда, даже +0: от неё сильно зависит цена
    if (l.ptn !== null && l.ptn !== undefined && (l.qlt !== null || l.ptn > 0)) out.push(h('span', { class: 'tag' }, '+' + l.ptn));
    return out;
  }

  /** «Редкий +5»: с чем именно сравнивалась цена лота. */
  function basisLabel(b) {
    if (!b) return '';
    const q = b.qlt !== null && b.qlt !== undefined && QLT[b.qlt] ? QLT[b.qlt][0] : '';
    let p = '';
    if (b.ptn !== null && b.ptn !== undefined) p = b.exact ? '+' + b.ptn : '+' + b.ptnFrom + '…+' + b.ptn;
    return (q + ' ' + p).trim();
  }
  function refTitle(ref) {
    if (!ref) return '';
    const label = basisLabel(ref.basis);
    return 'Медиана продаж' + (label ? ' (' + label + ')' : '') + ': ' + rub(ref.median) + ', продаж в выборке: ' + ref.samples + (ref.basis && ref.basis.exact === false ? '. Точных продаж мало, взяты соседние заточки ниже.' : '');
  }

  function lotRow(l, { onOpen, showName = true, fresh = false } = {}) {
    const hasBuyout = l.buyoutPrice > 0;
    const main = h(
      'div',
      { class: 'lot-main' },
      h('div', { class: 'lot-name' }, showName ? h('span', { class: 'nm' }, l.name) : null, h('span', { class: 'tag region' }, l.region.toUpperCase()), qualityBits(l)),
      h('div', { class: 'lot-meta' }, l.amount > 1 ? h('span', {}, '×' + formatMoney(l.amount)) : null, h('span', {}, ago(l.startTime)), !hasBuyout ? h('span', {}, 'только ставки') : null)
    );
    const disc = l.deal ? l.deal.discount : l.discount;
    const badge =
      disc !== null && disc !== undefined && Math.abs(disc) >= 0.05
        ? h('span', { class: 'badge' + (disc < 0 ? ' neg' : ''), title: refTitle(l.deal || l.ref) }, (disc > 0 ? '−' : '+') + Math.round(Math.abs(disc) * 100) + '%')
        : null;
    const price = h(
      'div',
      { class: 'lot-price' },
      h('div', { class: 'price num' }, hasBuyout ? rub(l.buyoutPrice) : h('span', {}, rub(l.currentPrice), ' ', h('small', {}, 'ставка'))),
      hasBuyout && l.amount > 1 ? h('div', { class: 'unit num' }, rub(l.unit) + ' за шт.') : null,
      badge
    );
    const tag = onOpen ? 'button' : 'div';
    return h(tag, { class: 'lot' + (fresh ? ' fresh' : ''), type: onOpen ? 'button' : null, onclick: onOpen }, thumb(l.icon, l.name), main, price);
  }

  function regionSeg(value, onChange, { all = true } = {}) {
    const box = h('div', { class: 'seg', role: 'group', 'aria-label': 'Регион' });
    const opts = [...(all ? [['all', 'Все']] : []), ...state.regions.map((r) => [r, r.toUpperCase()])];
    for (const [v, label] of opts) {
      box.append(h('button', { type: 'button', 'aria-pressed': String(v === value), onclick: () => onChange(v) }, label));
    }
    return box;
  }

  function viewAuction(root) {
    const view = { region: state.region, lastSeq: 0, open: null };
    const top = h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'Аукцион'), h('div', { id: 'status' }));
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Найти предмет: АК-74, Душа, аптечка…', autocomplete: 'off', 'aria-label': 'Поиск предмета' });
    const searchbox = h('div', { class: 'searchbox' }, icon('search'), input);
    const results = h('div', { class: 'card results hidden' });
    const body = h('div', { class: 'page' });
    root.append(h('div', { class: 'page' }, top, h('div', {}, searchbox, results), body));

    /* --- статус сканера --- */
    const statusEl = top.querySelector('#status');
    async function refreshStatus() {
      try {
        const s = await api('/auction/status');
        const demo = s.mode === 'demo';
        statusEl.replaceChildren(
          h('span', { class: 'status-pill' + (demo ? ' demo' : ''), title: demo ? s.demoReason : s.lastError || '' }, h('i'), demo ? 'Демо-данные' : 'Live · ' + s.regions.map((r) => r.toUpperCase()).join(' + '))
        );
        state.demo = demo;
        view.status = s;
      } catch (_) {}
    }
    refreshStatus();
    interval(refreshStatus, 15000);

    /* --- сканер: на Cloudflare нет фонового процесса, поэтому шаг сканирования запускает открытая страница --- */
    let ticking = false;
    async function runTick() {
      if (document.hidden || ticking) return;
      ticking = true;
      try {
        await api('/auction/tick', { method: 'POST', body: {} });
      } catch (_) {
      } finally {
        ticking = false;
      }
    }
    runTick();
    interval(runTick, 3000);

    /* --- поиск --- */
    let searchTimer = null;
    let searchSeq = 0;
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      const q = input.value.trim();
      if (!q) return results.classList.add('hidden');
      searchTimer = setTimeout(async () => {
        const my = ++searchSeq;
        try {
          const r = await api('/auction/search?q=' + encodeURIComponent(q));
          if (my !== searchSeq) return;
          results.replaceChildren();
          if (!r.items.length) results.append(h('div', { class: 'empty' }, h('strong', {}, 'Ничего не нашлось'), 'Проверьте название: поиск идёт по русским названиям предметов.'));
          for (const it of r.items) {
            results.append(
              h(
                'button',
                {
                  class: 'result',
                  type: 'button',
                  onclick: () => {
                    results.classList.add('hidden');
                    input.value = '';
                    openItem(it.id, view.region === 'all' ? state.regions[0] : view.region);
                  }
                },
                thumb(it.icon, it.name),
                h('span', { class: 'nm' }, it.name)
              )
            );
          }
          results.classList.remove('hidden');
        } catch (_) {}
      }, 180);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        input.value = '';
        results.classList.add('hidden');
      }
    });

    /* --- главная: лента + выгодные лоты --- */
    let feedTimer = null;
    let dealsTimer = null;
    function stopPolling() {
      clearInterval(feedTimer);
      clearInterval(dealsTimer);
    }
    onLeave(() => {
      stopPolling();
      clearTimeout(searchTimer);
    });

    function showHome() {
      stopPolling();
      view.open = null;
      view.lastSeq = 0;
      body.replaceChildren();

      const feedList = h('div', { class: 'card lots feed', 'aria-live': 'polite' });
      const dealsBox = h('div', { class: 'deals' });
      const feedEmpty = () =>
        h(
          'div',
          { class: 'empty' },
          h('strong', {}, 'Лента пока пуста'),
          view.status && view.status.mode === 'live' ? 'Сканер просматривает аукцион (' + Math.round((view.status.progress || 0) * 100) + '% круга). Он работает, пока эта страница открыта; новые лоты появятся здесь по мере обнаружения.' : 'Сканер запускается, подождите несколько секунд.'
        );
      feedList.append(feedEmpty());
      const dealsEmpty = h('div', { class: 'card empty', style: { gridColumn: '1 / -1' } }, h('strong', {}, 'Подходящих лотов пока нет'), 'Для сравнения нужна история продаж того же качества и заточки. Лоты появятся по мере сканирования, пока страница открыта.');
      dealsBox.append(dealsEmpty);

      const regionBar = regionSeg(view.region, (v) => {
        view.region = state.region = v;
        showHome();
      });

      body.append(
        h(
          'section',
          { class: 'section' },
          h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, h('span', { class: 'live-dot' }), 'Новые лоты'), regionBar),
          feedList
        ),
        h(
          'section',
          { class: 'section' },
          h('div', { class: 'section-head' }, h('h2', { class: 'section-title' }, 'Выгодные лоты'), h('span', { class: 'sub' }, 'Ниже медианы продаж того же качества и той же заточки')),
          dealsBox
        )
      );

      const open = (l) => () => {
        openItem(l.itemId, l.region);
      };

      async function loadFeed(first) {
        if (document.hidden) return;
        try {
          const r = await api('/auction/feed?region=' + view.region + '&after=' + view.lastSeq + '&limit=' + (first ? 40 : 60));
          view.lastSeq = Math.max(view.lastSeq, r.seq);
          if (!r.items.length) {
            if (first && !feedList.querySelector('.lot')) feedList.replaceChildren(feedEmpty());
            return;
          }
          if (!feedList.querySelector('.lot')) feedList.replaceChildren();
          const frag = document.createDocumentFragment();
          for (const l of r.items) frag.append(lotRow(l, { onOpen: open(l), fresh: !first }));
          feedList.prepend(frag);
          if (feedList.scrollTop < 40) feedList.scrollTop = 0;
          while (feedList.children.length > 60) feedList.lastChild.remove();
        } catch (_) {}
      }
      async function loadDeals() {
        if (document.hidden) return;
        try {
          const r = await api('/auction/deals?region=' + view.region + '&limit=6');
          if (!r.items.length) return dealsBox.replaceChildren(dealsEmpty);
          dealsBox.replaceChildren(...r.items.map((l) => dealCard(l, open(l))));
        } catch (_) {}
      }
      loadFeed(true);
      loadDeals();
      feedTimer = setInterval(() => loadFeed(false), 6000);
      dealsTimer = setInterval(loadDeals, 20000);
      // Пока лента пустая — чаще проверяем, чтобы подхватить первые лоты.
      const warm = setInterval(() => {
        if (feedList.querySelector('.lot')) clearInterval(warm);
        else {
          loadFeed(true);
          loadDeals();
        }
      }, 2500);
      onLeave(() => clearInterval(warm));
    }

    function dealCard(l, onOpen) {
      return h(
        'button',
        { class: 'deal', type: 'button', onclick: onOpen },
        h('div', { class: 'deal-top' }, thumb(l.icon, l.name), h('div', { style: { minWidth: 0 } }, h('span', { class: 'nm' }, l.name), h('div', { class: 'lot-name' }, h('span', { class: 'tag region' }, l.region.toUpperCase()), qualityBits(l), l.amount > 1 ? h('span', { class: 'tag' }, '×' + formatMoney(l.amount)) : null)), h('div', { class: 'deal-off num' }, '−' + Math.round(l.deal.discount * 100) + '%')),
        h(
          'div',
          { class: 'deal-bottom' },
          h('div', {}, h('div', { class: 'deal-price num' }, rub(l.buyoutPrice)), h('div', { class: 'deal-note num' }, 'медиана ' + rub(l.deal.median) + (l.amount > 1 ? ' за шт.' : '')), basisLabel(l.deal.basis) ? h('div', { class: 'deal-basis num' }, 'для «' + basisLabel(l.deal.basis) + '», ' + l.deal.samples + ' прод.') : null),
          h('div', { class: 'deal-note', style: { textAlign: 'right' } }, 'выгода ' + formatShort(l.deal.savings) + ' ₽', h('br'), ago(l.startTime))
        )
      );
    }

    /* --- страница предмета --- */
    function openItem(id, region) {
      stopPolling();
      view.open = { id, region };
      body.replaceChildren();
      const holder = h('div', { class: 'page' });
      body.append(holder);

      async function load(initial) {
        if (document.hidden && !initial) return;
        try {
          const d = await api('/auction/item/' + encodeURIComponent(id) + '?region=' + region);
          if (!view.open || view.open.id !== id || view.open.region !== region) return;
          holder.replaceChildren(...itemPanel(d));
        } catch (ex) {
          if (initial) holder.replaceChildren(backButton(), h('div', { class: 'toast-err' }, ex.message));
        }
      }
      const backButton = () => h('button', { class: 'btn ghost small', type: 'button', onclick: showHome, style: { justifySelf: 'start' } }, icon('back'), 'К ленте');

      // Выбранные фильтры живут вне itemPanel: страница перерисовывается каждые 20 секунд.
      const sel = { qlt: 'all', ptn: 'all' };
      let lastData = null;
      const rerender = () => lastData && holder.replaceChildren(...itemPanel(lastData));
      const medianOf = (arr) => {
        const a = arr.slice().sort((x, y) => x - y);
        const n = a.length;
        return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : 0;
      };

      function itemPanel(d) {
        lastData = d;
        const s = d.stats;
        const qltsPresent = [...new Set([...d.groups.map((g) => g[0]), ...d.lots.map((l) => l.qlt)].filter((v) => v !== null && v !== undefined))].sort((x, y) => x - y);
        if (sel.qlt !== 'all' && !qltsPresent.includes(sel.qlt)) sel.qlt = 'all';
        const ptnsPresent = [...new Set([...d.groups.filter((g) => g[0] === sel.qlt).map((g) => g[1]), ...d.lots.filter((l) => l.qlt === sel.qlt).map((l) => l.ptn ?? 0)])].filter((v) => v !== null).sort((x, y) => x - y);
        if (sel.ptn !== 'all' && !ptnsPresent.includes(sel.ptn)) sel.ptn = 'all';
        const filtered = sel.qlt !== 'all';

        const match = (q, p) => (sel.qlt === 'all' || q === sel.qlt) && (sel.ptn === 'all' || (p ?? 0) === sel.ptn);
        const lots = d.lots.filter((l) => match(l.qlt, l.ptn));
        const lotsWithBuyout = lots.filter((l) => l.buyoutPrice > 0);
        const minNow = lotsWithBuyout.length ? Math.min(...lotsWithBuyout.map((l) => l.unit)) : 0;

        // Медиана выбранной группы: у предметов с качеством она считается только по продажам того же качества и заточки.
        let medVal = null;
        let medNote = '';
        if (!d.hasQuality) {
          if (s) {
            medVal = s.median;
            medNote = s.samples + ' продаж';
          }
        } else if (!filtered) medNote = 'выберите качество';
        else if (sel.ptn !== 'all') {
          const g = d.groups.find((x) => x[0] === sel.qlt && x[1] === sel.ptn);
          if (g) {
            medVal = g[2];
            medNote = g[3] + ' продаж';
          } else medNote = 'нет продаж такой заточки';
        } else {
          const pts = d.history.filter((p) => p[2] === sel.qlt);
          if (pts.length) {
            medVal = medianOf(pts.map((p) => p[1]));
            medNote = 'любая заточка, выберите точную';
          } else medNote = 'нет продаж';
        }

        const nodes = [
          backButton(),
          h(
            'div',
            { class: 'item-head' },
            thumb(d.item.icon, d.item.name, 'lg'),
            h('h2', {}, d.item.name),
            h('div', { style: { marginLeft: 'auto' } }, regionSeg(region, (v) => openItem(id, v), { all: false }))
          )
        ];

        if (qltsPresent.length) {
          const chip = (value, label, color) =>
            h(
              'button',
              {
                class: 'chip',
                type: 'button',
                'aria-pressed': String(sel.qlt === value),
                onclick: () => {
                  sel.qlt = value;
                  sel.ptn = 'all';
                  rerender();
                }
              },
              color ? h('i', { class: 'dot', style: { color } }) : null,
              label
            );
          const bar = h('div', { class: 'filters', role: 'group', 'aria-label': 'Качество' }, chip('all', 'Любое'), qltsPresent.map((q) => chip(q, QLT[q] ? QLT[q][0] : 'Качество ' + q, QLT[q] && QLT[q][1])));
          if (filtered) {
            const pick = h(
              'select',
              {
                class: 'select',
                'aria-label': 'Заточка',
                onchange: (e) => {
                  sel.ptn = e.target.value === 'all' ? 'all' : Number(e.target.value);
                  rerender();
                }
              },
              h('option', { value: 'all' }, 'Любая заточка'),
              ptnsPresent.map((p) => h('option', { value: String(p) }, '+' + p))
            );
            pick.value = String(sel.ptn);
            bar.append(pick);
          }
          nodes.push(bar);
        }

        nodes.push(
          h(
            'div',
            { class: 'stats' },
            h('div', { class: 'card stat' }, h('span', { class: 'k' }, 'Медиана продаж'), h('span', { class: 'v num' }, medVal ? rub(medVal) : '—'), medNote ? h('span', { class: 's' }, medNote) : null),
            h('div', { class: 'card stat' }, h('span', { class: 'k' }, 'Дешевле всего сейчас'), h('span', { class: 'v num' }, minNow ? rub(minNow) : '—'), filtered ? h('span', { class: 's' }, 'с этим качеством' + (sel.ptn !== 'all' ? ' и заточкой' : '')) : null),
            h('div', { class: 'card stat' }, h('span', { class: 'k' }, 'Лотов на аукционе'), h('span', { class: 'v num' }, formatMoney(d.total)), filtered ? h('span', { class: 's' }, lots.length + ' по фильтру') : null)
          )
        );

        // График: для предметов с качеством только по выбранной группе, иначе цены разных качеств перемешаются.
        const chartPts = d.history.filter((p) => (d.hasQuality ? filtered && match(p[2], p[3]) : true)).map((p) => [p[0], p[1]]);
        if (chartPts.length > 2) nodes.push(sparkline(chartPts, { samples: chartPts.length }));

        nodes.push(
          h(
            'section',
            { class: 'section' },
            h('h2', { class: 'section-title' }, 'Лоты, сначала дешёвые'),
            lots.length
              ? h('div', { class: 'card lots' }, lots.slice(0, 60).map((l) => lotRow(l, { showName: false })))
              : h('div', { class: 'card empty' }, h('strong', {}, filtered ? 'Нет лотов с такими параметрами' : 'Сейчас лотов нет'), filtered ? 'Среди самых дешёвых лотов нет такого качества и заточки. Попробуйте другое.' : 'Предмет никто не продаёт в этом регионе.')
          )
        );
        return nodes;
      }

      holder.append(backButton(), h('div', { class: 'card empty' }, 'Загружаю…'));
      load(true);
      const t = setInterval(() => load(false), 20000);
      onLeave(() => clearInterval(t));
    }

    showHome();
  }

  function sparkline(points, stats) {
    const W = 320;
    const H = 100;
    const vals = points.map((p) => p[1]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const span = max - min || 1;
    const x = (i) => (i / (points.length - 1)) * W;
    const y = (v) => H - 6 - ((v - min) / span) * (H - 16);
    const line = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[1]).toFixed(1)).join(' ');
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'График цен последних продаж');
    svg.innerHTML =
      '<defs><linearGradient id="sl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#c8ff2e"/><stop offset="1" stop-color="#1fff8f"/></linearGradient>' +
      '<linearGradient id="sf" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#6dff5c" stop-opacity=".22"/><stop offset="1" stop-color="#6dff5c" stop-opacity="0"/></linearGradient></defs>' +
      `<path d="${line} L${W} ${H} L0 ${H} Z" fill="url(#sf)"/>` +
      `<path d="${line}" fill="none" stroke="url(#sl)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    const first = points[0][0];
    const last = points[points.length - 1][0];
    const days = Math.max(1, Math.round((last - first) / 86400000));
    return h('div', { class: 'card chart' }, h('div', { class: 'chart-foot' }, h('span', {}, 'Цена за штуку в проданных лотах'), h('span', { class: 'num' }, formatShort(min) + ' – ' + formatShort(max) + ' ₽')), svg, h('div', { class: 'chart-foot' }, h('span', {}, 'за ' + days + ' дн.'), h('span', {}, stats ? stats.samples + ' продаж в выборке' : '')));
  }

  /* ===================== вкладка 2: бухгалтер ===================== */

  function viewLedger(root) {
    let data = null;
    let type = 'income';
    let editingStart = false;
    let summary = null;
    let shown = 60;

    const page = h('div', { class: 'page' });
    root.append(page);

    const amount = h('input', { class: 'input num', id: 'amount', inputmode: 'text', autocomplete: 'off', placeholder: '10к, 1.5кк, 10000…', 'aria-describedby': 'amount-hint' });
    const note = h('input', { class: 'input', id: 'note', autocomplete: 'off', maxlength: 120, placeholder: 'За что? (необязательно)' });
    const hint = h('div', { class: 'hint', id: 'amount-hint', 'aria-live': 'polite' }, 'Можно писать 10к, 10 000, 1,5кк, 2 млн');
    const submit = h('button', { class: 'btn', type: 'submit' }, icon('plus'), 'Добавить доход');
    const formErr = h('div', { class: 'toast-err hidden', role: 'alert' });

    const seg = h('div', { class: 'seg expense', role: 'group', 'aria-label': 'Тип операции' });
    const bInc = h('button', { type: 'button', class: 'is-income', 'aria-pressed': 'true', onclick: () => setType('income') }, 'Доход');
    const bExp = h('button', { type: 'button', class: 'is-expense', 'aria-pressed': 'false', onclick: () => setType('expense') }, 'Расход');
    seg.append(bInc, bExp);
    function setType(t) {
      type = t;
      bInc.setAttribute('aria-pressed', String(t === 'income'));
      bExp.setAttribute('aria-pressed', String(t === 'expense'));
      submit.replaceChildren(icon('plus'), t === 'income' ? 'Добавить доход' : 'Добавить расход');
    }

    amount.addEventListener('input', () => {
      const v = amount.value.trim();
      formErr.classList.add('hidden');
      if (!v) {
        hint.className = 'hint';
        hint.textContent = 'Можно писать 10к, 10 000, 1,5кк, 2 млн';
        return;
      }
      const r = parseMoney(v);
      if (r.ok) {
        hint.className = 'hint ok num';
        hint.textContent = '= ' + rub(r.value);
      } else {
        hint.className = 'hint err';
        hint.textContent = r.error;
      }
    });

    const form = h(
      'form',
      {
        class: 'card entry-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const r = parseMoney(amount.value);
          if (!r.ok || r.value === 0) {
            hint.className = 'hint err';
            hint.textContent = r.ok ? 'Сумма должна быть больше нуля' : r.error;
            amount.focus();
            return;
          }
          submit.disabled = true;
          try {
            await api('/ledger/entries', { method: 'POST', body: { type, amount: amount.value, note: note.value } });
            amount.value = '';
            note.value = '';
            hint.className = 'hint';
            hint.textContent = type === 'income' ? 'Доход добавлен' : 'Расход добавлен';
            summary = null;
            await load();
            amount.focus();
          } catch (ex) {
            formErr.textContent = ex.message;
            formErr.classList.remove('hidden');
          } finally {
            submit.disabled = false;
          }
        }
      },
      h('div', { class: 'entry-grid' }, h('div', { class: 'field' }, h('label', { for: 'amount' }, 'Сумма'), amount), h('div', { class: 'field' }, h('label', { for: 'note' }, 'Комментарий'), note)),
      hint,
      formErr,
      h('div', { class: 'entry-actions' }, seg, h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap' } }, h('button', { class: 'btn ghost', type: 'button', onclick: showSummary }, icon('bolt'), 'Итог дня'), submit))
    );

    const balanceBox = h('div', { class: 'card balance-card' });
    const summaryBox = h('div');
    const historyBox = h('div', { class: 'section' });
    page.append(h('div', { class: 'page-head' }, h('h1', { class: 'page-title' }, 'Бухгалтер')), balanceBox, form, summaryBox, historyBox);

    async function load() {
      try {
        data = await api('/ledger?limit=500');
        draw();
      } catch (ex) {
        balanceBox.replaceChildren(h('div', { class: 'toast-err' }, ex.message));
      }
    }

    function drawBalance() {
      const neg = data.balance < 0;
      const startBlock = editingStart
        ? (() => {
            const inp = h('input', { class: 'input num', value: String(data.start), 'aria-label': 'Стартовый баланс', autocomplete: 'off' });
            const err = h('span', { class: 'hint err' });
            const save = async () => {
              const r = parseMoney(inp.value);
              if (!r.ok) {
                err.textContent = r.error;
                return;
              }
              try {
                await api('/ledger/start', { method: 'PUT', body: { value: inp.value } });
                editingStart = false;
                summary = null;
                await load();
              } catch (ex) {
                err.textContent = ex.message;
              }
            };
            inp.addEventListener('keydown', (e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') {
                editingStart = false;
                draw();
              }
            });
            setTimeout(() => {
              inp.focus();
              inp.select();
            }, 0);
            return h('div', { class: 'mini' }, h('span', { class: 'k' }, 'Стартовый баланс'), h('div', { class: 'start-edit' }, inp, h('button', { class: 'btn small', type: 'button', onclick: save }, 'Сохранить'), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Отмена', onclick: () => ((editingStart = false), draw()) }, icon('close'))), err);
          })()
        : h('div', { class: 'mini' }, h('span', { class: 'k' }, 'Стартовый баланс'), h('div', { class: 'start-edit' }, h('span', { class: 'v num' }, rub(data.start)), h('button', { class: 'btn ghost small', type: 'button', onclick: () => ((editingStart = true), draw()) }, data.entries.length || data.start ? 'Изменить' : 'Указать')));

      balanceBox.replaceChildren(
        h('div', {}, h('div', { class: 'balance-label' }, 'Баланс сейчас'), h('div', { class: 'balance num' + (neg ? ' neg' : ''), 'aria-live': 'polite' }, formatMoney(data.balance), h('small', {}, '₽'))),
        h('div', { class: 'balance-row' }, startBlock, h('div', { class: 'mini' }, h('span', { class: 'k' }, 'Доходы всего'), h('span', { class: 'v pos num' }, '+' + formatMoney(data.income))), h('div', { class: 'mini' }, h('span', { class: 'k' }, 'Расходы всего'), h('span', { class: 'v neg num' }, '−' + formatMoney(data.expense))))
      );
    }

    function drawHistory() {
      historyBox.replaceChildren();
      historyBox.append(h('h2', { class: 'section-title' }, 'История операций'));
      if (!data.entries.length) {
        historyBox.append(h('div', { class: 'card empty' }, h('strong', {}, 'Операций пока нет'), 'Введите сумму выше и нажмите «Добавить доход» или «Добавить расход».'));
        return;
      }
      const card = h('div', { class: 'card' });
      let lastDay = '';
      for (const e of data.entries.slice(0, shown)) {
        const dk = dayKey(e.ts);
        if (dk !== lastDay) {
          lastDay = dk;
          card.append(h('div', { class: 'day-label' }, dayLabel(e.ts)));
        }
        const inc = e.type === 'income';
        card.append(
          h(
            'div',
            { class: 'entry' },
            h('div', { class: 'sign' + (inc ? '' : ' out') }, inc ? '+' : '−'),
            h('div', { class: 'entry-note' }, e.note || (inc ? 'Доход' : 'Расход')),
            h('div', { class: 'entry-time num' }, clock(e.ts)),
            h('div', { class: 'entry-sum num ' + (inc ? 'pos' : 'neg') }, (inc ? '+' : '−') + formatMoney(e.amount)),
            deleteButton(async () => {
              try {
                await api('/ledger/entries/' + e.id, { method: 'DELETE' });
                summary = null;
                await load();
              } catch (_) {}
            })
          )
        );
      }
      historyBox.append(card);
      if (data.entries.length > shown) {
        historyBox.append(
          h(
            'button',
            {
              class: 'btn ghost small',
              type: 'button',
              style: { justifySelf: 'center' },
              onclick: () => {
                shown += 60;
                drawHistory();
              }
            },
            'Показать ещё'
          )
        );
      }
    }

    function drawSummary() {
      summaryBox.replaceChildren();
      if (!summary) return;
      const s = summary;
      const d = new Date(s.from);
      const verdictText = s.verdict === 'plus' ? 'День в плюсе' : s.verdict === 'minus' ? 'День в минусе' : 'День в нуле';
      const parts = [];
      if (!s.incomeCount && !s.expenseCount) {
        parts.push(h('span', {}, 'Сегодня операций ещё не было.'));
      } else {
        parts.push(h('span', {}, 'Заработано ', h('b', { class: 'num' }, rub(s.earned)), s.incomeCount ? ` (${s.incomeCount} ${plural(s.incomeCount, 'операция', 'операции', 'операций')})` : '', ', потрачено ', h('b', { class: 'num' }, rub(s.spent)), s.expenseCount ? ` (${s.expenseCount} ${plural(s.expenseCount, 'операция', 'операции', 'операций')})` : '', '. '));
        if (s.topIncome) parts.push(h('span', {}, 'Крупнейший доход: ', h('b', { class: 'num' }, rub(s.topIncome.amount)), s.topIncome.note ? ' (' + s.topIncome.note + ')' : '', '. '));
        if (s.topExpense) parts.push(h('span', {}, 'Крупнейший расход: ', h('b', { class: 'num' }, rub(s.topExpense.amount)), s.topExpense.note ? ' (' + s.topExpense.note + ')' : '', '.'));
      }
      summaryBox.append(
        h(
          'section',
          { class: 'summary' + (s.verdict === 'minus' ? ' minus' : ''), 'aria-label': 'Итог дня' },
          h('div', { class: 'summary-head' }, h('div', {}, h('div', { class: 'sub' }, 'Итог за сегодня, ' + d.getDate() + ' ' + MONTHS[d.getMonth()]), h('div', { class: 'summary-verdict num' }, verdictText + ': ' + formatSigned(s.net) + ' ₽')), h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Закрыть итог', onclick: () => ((summary = null), drawSummary()) }, icon('close'))),
          h(
            'div',
            { class: 'summary-grid' },
            h('div', { class: 'mini' }, h('span', { class: 'k' }, 'Заработано'), h('span', { class: 'v pos num' }, '+' + formatMoney(s.earned))),
            h('div', { class: 'mini' }, h('span', { class: 'k' }, 'Убытки'), h('span', { class: 'v neg num' }, '−' + formatMoney(s.spent))),
            h('div', { class: 'mini' }, h('span', { class: 'k' }, 'Баланс утром'), h('span', { class: 'v num' }, rub(s.balanceStart))),
            h('div', { class: 'mini' }, h('span', { class: 'k' }, 'Баланс сейчас'), h('span', { class: 'v num ' + (s.balanceEnd >= 0 ? 'pos' : 'neg') }, rub(s.balanceEnd)))
          ),
          h('p', { class: 'summary-text' }, parts)
        )
      );
      summaryBox.firstChild.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    async function showSummary() {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      try {
        summary = await api('/ledger/summary?from=' + start.getTime() + '&to=' + end.getTime());
        drawSummary();
      } catch (ex) {
        formErr.textContent = ex.message;
        formErr.classList.remove('hidden');
      }
    }

    function draw() {
      drawBalance();
      drawHistory();
      if (summary) showSummary();
    }

    balanceBox.append(h('div', { class: 'sub' }, 'Загружаю…'));
    load();
  }

  const plural = (n, a, b, c) => {
    const m10 = n % 10;
    const m100 = n % 100;
    return m10 === 1 && m100 !== 11 ? a : m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? b : c;
  };

  /* ===================== вкладка 3: заметки ===================== */

  const noteTitle = (t) => (String(t).split('\n').find((l) => l.trim()) || '').trim();
  function notePreview(t) {
    const lines = String(t).split('\n').map((l) => l.trim()).filter(Boolean);
    return lines.slice(1).join(' ');
  }
  function noteDate(ts) {
    const d = dayLabel(ts);
    return d === 'Сегодня' ? 'Сегодня ' + clock(ts) : d === 'Вчера' ? 'Вчера' : new Date(ts).getDate() + ' ' + MONTHS[new Date(ts).getMonth()].slice(0, 3) + '.';
  }

  function viewNotes(root) {
    const list = h('div', { class: 'card', style: { overflow: 'hidden' } });
    const addBtn = h(
      'button',
      {
        class: 'btn',
        type: 'button',
        onclick: async () => {
          addBtn.disabled = true;
          try {
            const r = await api('/notes', { method: 'POST', body: { text: '' } });
            location.hash = '#/notes/' + r.note.id;
          } catch (ex) {
            list.replaceChildren(h('div', { class: 'toast-err' }, ex.message));
            addBtn.disabled = false;
          }
        }
      },
      icon('plus'),
      'Новая заметка'
    );
    const count = h('p', { class: 'sub' });
    root.append(h('div', { class: 'page' }, h('div', { class: 'page-head' }, h('div', {}, h('h1', { class: 'page-title' }, 'Заметки'), count), addBtn), list));

    async function load() {
      try {
        const { notes } = await api('/notes');
        count.textContent = notes.length ? notes.length + ' ' + plural(notes.length, 'заметка', 'заметки', 'заметок') : '';
        list.replaceChildren();
        if (!notes.length) {
          list.append(h('div', { class: 'empty' }, h('strong', {}, 'Заметок пока нет'), 'Например: «Цена на Душу скоро вырастет — докупить заранее».'));
          return;
        }
        for (const n of notes) {
          list.append(
            h(
              'div',
              { style: { position: 'relative' } },
              h(
                'button',
                { class: 'note-row', type: 'button', onclick: () => (location.hash = '#/notes/' + n.id) },
                h('div', { style: { minWidth: 0 } }, h('div', { class: 'note-title' }, noteTitle(n.text) || 'Пустая заметка'), h('div', { class: 'note-meta' }, h('span', {}, noteDate(n.updatedAt)), notePreview(n.text) || 'Нет дополнительного текста')),
                h('div', { class: 'note-actions', style: { width: '40px' } }, icon('chev', 'chev'))
              ),
              h(
                'div',
                { style: { position: 'absolute', right: '40px', top: '50%', transform: 'translateY(-50%)' } },
                deleteButton(async () => {
                  try {
                    await api('/notes/' + n.id, { method: 'DELETE' });
                    await load();
                  } catch (_) {}
                }, { label: 'Удалить заметку' })
              )
            )
          );
        }
      } catch (ex) {
        list.replaceChildren(h('div', { class: 'toast-err' }, ex.message));
      }
    }
    load();
  }

  function viewNote(root, id) {
    const area = h('textarea', { class: 'note-area', placeholder: 'Первая строка станет заголовком. Пишите что угодно.', 'aria-label': 'Текст заметки', spellcheck: 'true' });
    const saveState = h('span', { class: 'save-state', 'aria-live': 'polite' });
    const dateEl = h('div', { class: 'note-date' });
    let loaded = false;
    let dirty = false;
    let saving = Promise.resolve();
    let timer = null;
    let gone = false;

    function fit() {
      area.style.height = 'auto';
      area.style.height = Math.max(area.scrollHeight, window.innerHeight * 0.55) + 'px';
    }
    function save() {
      clearTimeout(timer);
      if (!loaded || !dirty || gone) return saving;
      dirty = false;
      saveState.textContent = 'Сохраняю…';
      const text = area.value;
      saving = saving
        .then(() => api('/notes/' + id, { method: 'PUT', body: { text } }))
        .then(() => {
          saveState.textContent = 'Сохранено';
        })
        .catch(() => {
          dirty = true;
          saveState.textContent = 'Не удалось сохранить';
        });
      return saving;
    }
    area.addEventListener('input', () => {
      dirty = true;
      saveState.textContent = '';
      fit();
      clearTimeout(timer);
      timer = setTimeout(save, 700);
    });

    async function leave() {
      await save();
      // Пустая заметка при выходе удаляется, как в заметках iOS.
      if (loaded && !gone && !area.value.trim()) {
        gone = true;
        try {
          await api('/notes/' + id, { method: 'DELETE' });
        } catch (_) {}
      }
      location.hash = '#/notes';
    }
    const back = h('button', { class: 'back', type: 'button', onclick: leave }, icon('back'), 'Заметки');
    const del = deleteButton(async () => {
      gone = true;
      clearTimeout(timer);
      try {
        await api('/notes/' + id, { method: 'DELETE' });
      } catch (_) {}
      location.hash = '#/notes';
    }, { label: 'Удалить заметку' });

    root.append(h('div', { class: 'note-view' }, h('div', { class: 'note-bar' }, back, dateEl, h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', justifyContent: 'flex-end' } }, saveState, del)), area));

    onLeave(() => {
      clearTimeout(timer);
      // Уходим по другой ссылке (вкладка, «назад») — сохраняем то, что успели набрать.
      if (loaded && dirty && !gone) {
        const text = area.value;
        api('/notes/' + id, { method: 'PUT', body: { text } }).catch(() => {});
      }
    });

    (async () => {
      try {
        const { note } = await api('/notes/' + id);
        area.value = note.text;
        const d = new Date(note.updatedAt);
        dateEl.textContent = d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + clock(note.updatedAt);
        loaded = true;
        fit();
        if (!note.text) area.focus();
      } catch (ex) {
        root.replaceChildren(h('div', { class: 'page' }, h('button', { class: 'btn ghost small', type: 'button', style: { justifySelf: 'start' }, onclick: () => (location.hash = '#/notes') }, icon('back'), 'К заметкам'), h('div', { class: 'toast-err' }, ex.status === 404 ? 'Эта заметка уже удалена.' : ex.message)));
      }
    })();
  }

  /* ===================== старт ===================== */

  (async function boot() {
    try {
      const cfg = await fetch('/api/config').then((r) => r.json());
      state.regions = cfg.regions;
      state.demo = cfg.demo;
      const me = await api('/auth/me');
      if (me.user) {
        state.user = me.user;
        route();
      } else renderAuth();
    } catch (_) {
      $app.replaceChildren(h('div', { class: 'auth-wrap' }, h('div', { class: 'card empty' }, h('strong', {}, 'Сервер не отвечает'), 'Проверьте, что BugalterSZ запущен, и обновите страницу.')));
    }
  })();
})();
