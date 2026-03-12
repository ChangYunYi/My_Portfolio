/* ═══════════════════════════════════════════════════════
   LOG PANEL — 데이터 페칭 로그 모니터
   ▸ console.log/warn/error 중 [KIS], [RS], [Yahoo], [Data] 태그를 캡처
   ▸ 화면 하단 토글 패널에 실시간 표시
   ═══════════════════════════════════════════════════════ */

const LogPanel = (() => {
  const MAX_LINES = 200;
  const TAGS = ["[KIS]", "[RS]", "[Yahoo]", "[Data]", "[Finnhub]"];
  let _logs = [];
  let _el = null;
  let _listEl = null;
  let _btnEl = null;
  let _open = false;
  let _unread = 0;

  /* ── console 인터셉트 ── */

  function _hook() {
    const orig = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };

    function intercept(level, origFn, args) {
      origFn(...args);
      const msg = args.map(a => typeof a === "string" ? a : String(a)).join(" ");
      if (!TAGS.some(t => msg.includes(t))) return;
      _push(level, msg);
    }

    console.log = (...a) => intercept("info", orig.log, a);
    console.warn = (...a) => intercept("warn", orig.warn, a);
    console.error = (...a) => intercept("error", orig.error, a);
  }

  function _push(level, msg) {
    const now = new Date();
    const ts = now.toLocaleTimeString("ko-KR", { hour12: false });
    _logs.push({ ts, level, msg });
    if (_logs.length > MAX_LINES) _logs.shift();

    if (_listEl) _renderLine(_logs[_logs.length - 1]);

    if (!_open) {
      _unread++;
      _updateBadge();
    }
  }

  /* ── UI 생성 ── */

  function _createUI() {
    // 토글 버튼
    _btnEl = document.createElement("button");
    _btnEl.id = "logPanelBtn";
    _btnEl.innerHTML = "📋 LOG";
    _btnEl.onclick = () => _toggle();
    document.body.appendChild(_btnEl);

    // 패널
    _el = document.createElement("div");
    _el.id = "logPanel";
    _el.innerHTML = `
      <div class="lp-header">
        <span class="lp-title">Data Fetch Log</span>
        <div class="lp-actions">
          <button onclick="LogPanel.clear()" class="lp-act">Clear</button>
          <button onclick="LogPanel.toggle()" class="lp-act">✕</button>
        </div>
      </div>
      <div class="lp-list" id="logPanelList"></div>
    `;
    document.body.appendChild(_el);
    _listEl = document.getElementById("logPanelList");
  }

  function _renderLine(entry) {
    if (!_listEl) return;
    const div = document.createElement("div");
    div.className = "lp-line lp-" + entry.level;

    // 태그 색상 하이라이트
    let html = `<span class="lp-ts">${entry.ts}</span> `;
    let m = entry.msg;
    m = m.replace(/\[(KIS|RS|Yahoo|Data|Finnhub)\]/g, '<span class="lp-tag lp-tag-$1">[$1]</span>');
    html += m;
    div.innerHTML = html;

    _listEl.appendChild(div);
    // 자동 스크롤
    _listEl.scrollTop = _listEl.scrollHeight;
  }

  function _updateBadge() {
    if (!_btnEl) return;
    if (_unread > 0) {
      _btnEl.innerHTML = `📋 LOG <span class="lp-badge">${_unread > 99 ? "99+" : _unread}</span>`;
    } else {
      _btnEl.innerHTML = "📋 LOG";
    }
  }

  /* ── 공개 API ── */

  function toggle() {
    _open = !_open;
    if (_el) _el.classList.toggle("lp-open", _open);
    if (_open) {
      _unread = 0;
      _updateBadge();
      // 기존 로그 렌더링
      if (_listEl && _listEl.children.length === 0) {
        _logs.forEach(e => _renderLine(e));
      }
    }
  }
  // _toggle alias
  const _toggle = toggle;

  function clear() {
    _logs = [];
    if (_listEl) _listEl.innerHTML = "";
    _unread = 0;
    _updateBadge();
  }

  function init() {
    _hook();
    _createUI();
  }

  // DOM 준비되면 자동 초기화
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  return { toggle, clear };
})();
