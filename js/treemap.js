/* ═══════════════════════════════════════════════════════
   treemap.js — Squarified 트리맵 레이아웃 알고리즘
   ═══════════════════════════════════════════════════════ */

/**
 * Squarified 트리맵 레이아웃 계산
 * @param {Array<{value:number, ...}>} data - 값과 메타데이터 배열
 * @param {number} x - 시작 X 좌표
 * @param {number} y - 시작 Y 좌표
 * @param {number} w - 너비
 * @param {number} h - 높이
 * @returns {Array<{x,y,w,h, ...}>} - 위치가 계산된 노드 배열
 */
function squarify(data, x, y, w, h) {
  const sorted = [...data].filter(d => d.value > 0).sort((a, b) => b.value - a.value);
  const totalVal = sorted.reduce((s, d) => s + d.value, 0);
  if (totalVal <= 0 || !sorted.length) return [];

  const totalArea = w * h;
  const nodes = sorted.map(d => ({ ...d, area: (d.value / totalVal) * totalArea }));
  const result = [];
  _layRows(nodes, x, y, w, h, result);
  return result;
}

/** 재귀적 행 배치 (내부 함수) */
function _layRows(nodes, x, y, w, h, out) {
  if (!nodes.length) return;
  if (nodes.length === 1) { out.push({ ...nodes[0], x, y, w, h }); return; }
  if (w <= 0 || h <= 0) return;

  const short = Math.min(w, h);
  let row = [], rowArea = 0, bestW = Infinity, splitAt = 1;

  for (let i = 0; i < nodes.length; i++) {
    row.push(nodes[i]);
    rowArea += nodes[i].area;
    const wr = _worstR(row, rowArea, short);
    if (wr <= bestW) { bestW = wr; splitAt = i + 1; }
    else break;
  }

  const rn = nodes.slice(0, splitAt), rm = nodes.slice(splitAt);
  const rA = rn.reduce((s, n) => s + n.area, 0), rL = rA / short;
  let off = 0;

  if (w >= h) {
    rn.forEach(n => { const cH = n.area / rL; out.push({ ...n, x, y: y + off, w: rL, h: cH }); off += cH; });
    if (rm.length) _layRows(rm, x + rL, y, w - rL, h, out);
  } else {
    rn.forEach(n => { const cW = n.area / rL; out.push({ ...n, x: x + off, y, w: cW, h: rL }); off += cW; });
    if (rm.length) _layRows(rm, x, y + rL, w, h - rL, out);
  }
}

/** 행의 종횡비 최악값 계산 (내부 함수) */
function _worstR(row, rowArea, short) {
  const rL = rowArea / short;
  let w = 0;
  for (const n of row) {
    const c = n.area / rL;
    const r = Math.max(rL / c, c / rL);
    if (r > w) w = r;
  }
  return w;
}
