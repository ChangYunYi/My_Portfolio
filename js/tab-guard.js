/* ═══════════════════════════════════════════════════════
   tab-guard.js — 멀티탭/멀티디바이스 크래시 방지
   ▸ 탭 리더 선출 (단일 탭만 데이터 fetch)
   ▸ 비활성 탭 타이머 전면 중단
   ▸ 리소스 누적 방지
   ═══════════════════════════════════════════════════════ */

const TabGuard = (() => {
  const TAB_ID = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const LEADER_KEY = "portfolio_leader";
  const HEARTBEAT_MS = 3000;
  const LEADER_TIMEOUT_MS = 8000;

  let _isLeader = false;
  let _heartbeatTimer = null;
  let _visible = !document.hidden;
  let _bc = null;
  let _pausedTimers = [];  // 비활성 시 정지된 타이머 복원용
  let _onBecomeLeader = null;
  let _onLoseLeader = null;
  let _onVisibilityChange = null;

  /* ── 리더 선출 (localStorage 기반, BroadcastChannel 보조) ── */

  function _tryBecomeLeader() {
    const now = Date.now();
    const raw = localStorage.getItem(LEADER_KEY);
    let leader = null;
    try { leader = raw ? JSON.parse(raw) : null; } catch { leader = null; }

    // 리더가 없거나 하트비트가 만료됐으면 리더 획득
    if (!leader || (now - leader.ts > LEADER_TIMEOUT_MS) || leader.id === TAB_ID) {
      _setLeader();
      return true;
    }
    return false;
  }

  function _setLeader() {
    _isLeader = true;
    localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, ts: Date.now() }));
    _broadcast({ type: "leader_claim", id: TAB_ID });
    if (_onBecomeLeader) _onBecomeLeader();
    console.log("[TabGuard] 이 탭이 리더");
  }

  function _startHeartbeat() {
    if (_heartbeatTimer) clearInterval(_heartbeatTimer);
    _heartbeatTimer = setInterval(() => {
      if (_isLeader) {
        localStorage.setItem(LEADER_KEY, JSON.stringify({ id: TAB_ID, ts: Date.now() }));
      } else {
        _tryBecomeLeader();
      }
    }, HEARTBEAT_MS);
  }

  /* ── BroadcastChannel (같은 브라우저 내 탭 간 통신) ── */

  function _initBroadcast() {
    if (typeof BroadcastChannel === "undefined") return;
    try {
      _bc = new BroadcastChannel("portfolio_tab_guard");
      _bc.onmessage = (e) => {
        const msg = e.data;
        if (msg.type === "leader_claim" && msg.id !== TAB_ID) {
          // 다른 탭이 리더를 가져감
          if (_isLeader) {
            _isLeader = false;
            if (_onLoseLeader) _onLoseLeader();
            console.log("[TabGuard] 리더 양보:", msg.id);
          }
        }
      };
    } catch { /* BroadcastChannel 미지원 환경 무시 */ }
  }

  function _broadcast(msg) {
    try { _bc?.postMessage(msg); } catch { /* ignore */ }
  }

  /* ── 탭 가시성 관리 ── */

  function _initVisibility() {
    document.addEventListener("visibilitychange", () => {
      _visible = !document.hidden;
      if (_onVisibilityChange) _onVisibilityChange(_visible);

      if (_visible) {
        // 탭이 다시 보이면 리더 경쟁
        _tryBecomeLeader();
      }
    });
  }

  /* ── 페이지 언로드 시 리더 해제 ── */

  function _initUnload() {
    window.addEventListener("beforeunload", () => {
      if (_isLeader) {
        localStorage.removeItem(LEADER_KEY);
        _broadcast({ type: "leader_release", id: TAB_ID });
      }
      try { _bc?.close(); } catch { /* ignore */ }
    });
  }

  /* ── 공개 API ── */

  function init(opts) {
    _onBecomeLeader = opts?.onBecomeLeader || null;
    _onLoseLeader = opts?.onLoseLeader || null;
    _onVisibilityChange = opts?.onVisibilityChange || null;

    _initBroadcast();
    _initVisibility();
    _initUnload();
    _tryBecomeLeader();
    _startHeartbeat();

    console.log("[TabGuard] 초기화 완료, TAB_ID:", TAB_ID);
  }

  return {
    init,
    get isLeader() { return _isLeader; },
    get isVisible() { return _visible; },
    get tabId() { return TAB_ID; },
  };
})();
