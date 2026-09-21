/*
 * 压印质检（Embossing QC）核心模块。
 * 同时供 Node 服务端与浏览器前端使用（UMD）。
 *
 * 质检流程：
 *   1. 以最近一次成功排版的设计凸点为基准；
 *   2. 解析用户粘贴的实测凸点 CSV（x_mm,y_mm），解析错误定位到具体行号；
 *   3. 对实测点先应用校准偏移 (offsetX, offsetY)：比较坐标 = 实测坐标 + 偏移；
 *   4. 在最大关联半径 maxRadius 内做一对一二分图匹配，目标依次为：
 *        a) 匹配对数最多；
 *        b) 总欧氏距离最小；
 *        c) 再相同则按“设计点序号之和、CSV 行号之和”稳定决胜
 *      （任何实测点最多被一个设计点匹配，禁止重复配对）；
 *   5. 配对距离 ≤ tolerance 为「合格」，否则「偏移超差」；
 *      未配对的设计点为「缺失」，未配对的实测点为「多余」。
 *
 * 自动校准（estimateCalibration）：用户粘贴无序实测点并给出 X/Y 最大校准量后，
 * 枚举每个“设计点 i － 实测点 j”的候选全局平移 (dx,dy)=(设计-实测)，仅保留
 * |dx|、|dy| 均不超限者；每个候选复用上面的同一一对一匹配，按
 *   ① 匹配对数最多 → ② 配对总残差最小 → ③ |dx|+|dy| 最小 →
 *   ④ dx 升序、再 dy 升序
 * 决出唯一平移。缺失/多余点不参与配对、也不会拉偏结果（不使用质心差）。
 *
 * 小角度刚体校准：在自动校准中另传 maxRotation（最大旋转角，°，≤ 10°）与
 * angleStep（角度步长，°，缺省 0.1°）即启用。系统在 -maxRotation…maxRotation
 * 范围内按角度步长取离散角度网格（必含 0°），对每个角度先围绕板材中心
 * （plateWidth/plateHeight 的几何中心；未提供时退化为设计点包围盒中心）
 * 旋转全部实测点，再在现有 X/Y 限幅内联合枚举候选平移，逐一复用同一一对一匹配，
 * 按
 *   ① 匹配对数最多 → ② 配对总残差最小 → ③ |旋转角| 最小 →
 *   ④ |dx|+|dy| 最小 → ⑤ dx 升序、dy 升序、角度升序（固定数值顺序）
 * 决出唯一刚体变换。未传 maxRotation 的调用行为与纯平移模式完全一致。
 *
 * 坐标单位均为毫米 mm，原点在板材左上角，x 向右、y 向下；旋转角单位为度（°），
 * 数学正方向（逆时针）为正，作用于“实测点”，校正坐标 = 绕中心旋转后 + 平移。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.QC = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 常量 ---------------- */

  var MAX_POINTS = 10000; // 单侧点数上限（设计点 / 实测点）

  // 匹配代价用 BigInt 编码：cost = 距离(1e-6 mm 整数) * TIE_SCALE + 决胜序号
  // 决胜序号最大约 nD*(nM+1)+nM，1e4 × 1e4 量级下总和 < 1e13，故 1e14 可保证
  // 任意 1e-6 mm 的距离差异都严格优先于序号决胜。
  var DIST_SCALE = 1000000;
  var TIE_SCALE = BigInt('100000000000000'); // 1e14

  var VERDICT = {
    PASS: 'pass',       // 合格
    OFFSET: 'offset',   // 偏移超差
    MISSING: 'missing', // 缺失
    EXTRA: 'extra'      // 多余
  };

  var VERDICT_LABEL = {
    pass: '合格',
    offset: '偏移超差',
    missing: '缺失',
    extra: '多余'
  };

  // 自动校准的计算规模保护：平移候选来自“设计点 × 实测点”配对
  var MAX_RAW_PAIRS = 2000000; // 原始点对枚举上限
  var MAX_OFFSET_CANDIDATES = 20000; // 限幅去重后的候选平移上限（每个角度）
  var MAX_TOTAL_RIGID_CANDIDATES = 200000; // 角度 × 平移候选总评估上限
  var MAX_ANGLE_CANDIDATES = 401;   // 离散角度数量上限（含 0°）
  var MAX_ROTATION_DEG = 10;        // 小角度刚体校准允许的最大旋转角（°）
  var DEFAULT_ANGLE_STEP = 0.1;     // 未给角度步长时的缺省值（°）

  /* ---------------- 工具 ---------------- */

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }
  function round4(n) { return Math.round(n * 10000) / 10000; }
  // 平移候选统一量化到 1e-6 mm 后再去重/比较，消除浮点尾差导致的伪重复候选
  function round6(n) { return Math.round(n * 1000000) / 1000000; }

  function hyp(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  var DEG2RAD = Math.PI / 180;

  // 角度（°）量化到 1e-6° 后去重/比较，消除浮点尾差导致的伪重复角度
  function roundDeg(a) { return Math.round(a * 1000000) / 1000000; }

  // 点 (x,y) 绕中心 (cx,cy) 旋转 angleDeg（度，数学正方向=逆时针）
  function rotateAbout(x, y, cx, cy, angleDeg) {
    var t = angleDeg * DEG2RAD;
    var co = Math.cos(t), si = Math.sin(t);
    var rx = x - cx, ry = y - cy;
    return { x: cx + rx * co - ry * si, y: cy + rx * si + ry * co };
  }

  // 旋转中心：优先取板材几何中心；板材尺寸缺失/非法时退化为设计点包围盒中心
  function resolveCenter(design, plateWidth, plateHeight) {
    if (isFinite(plateWidth) && plateWidth > 0 && isFinite(plateHeight) && plateHeight > 0) {
      return { cx: plateWidth / 2, cy: plateHeight / 2 };
    }
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (var i = 0; i < design.length; i++) {
      var p = design[i];
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (!isFinite(minX)) return { cx: 0, cy: 0 };
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  /* ---------------- 实测 CSV 解析 ----------------
   * 首行若为 x_mm,y_mm（大小写/空白宽容）则视为表头，可省略。
   * 空行跳过；任何非空行必须且只能有 2 列，且均为有限数字。
   * 返回 { points:[{x,y,row}], errors:[{line,message}] }，row 为物理行号（含表头）。
   */
  function parseMeasuredCsv(text) {
    var errors = [];
    var points = [];

    if (typeof text !== 'string') {
      return { points: points, errors: [{ line: null, message: 'CSV 内容必须是文本。' }] };
    }

    var clean = text.replace(/^\uFEFF/, ''); // 去 BOM（U+FEFF）
    var lines = clean.split(/\r\n|\r|\n/);

    var start = 0;
    // 寻找第一个非空行判断是否有表头
    for (var k = 0; k < lines.length; k++) {
      if (lines[k].trim() !== '') {
        var head = lines[k].split(',').map(function (s) { return s.trim().toLowerCase(); });
        if (head.length === 2 &&
            (head[0] === 'x_mm' || head[0] === 'x') &&
            (head[1] === 'y_mm' || head[1] === 'y')) {
          start = k + 1;
        }
        break;
      }
    }

    function fieldError(line, col, raw) {
      errors.push({
        line: line,
        message: '第 ' + line + ' 行：第 ' + col + ' 列坐标不是合法数字（收到 ' +
          (raw === '' ? '空值' : '“' + raw + '”') + '），应为 x_mm,y_mm 格式的毫米坐标。'
      });
    }

    for (var li = start; li < lines.length; li++) {
      var lineNo = li + 1;
      var rawLine = lines[li];
      if (rawLine.trim() === '') continue; // 允许空行
      if (points.length >= MAX_POINTS) {
        errors.push({ line: lineNo, message: '第 ' + lineNo + ' 行：实测点超过 ' + MAX_POINTS + ' 个上限，请缩减 CSV 后重试。' });
        break;
      }
      var parts = rawLine.split(',');
      if (parts.length !== 2) {
        errors.push({
          line: lineNo,
          message: '第 ' + lineNo + ' 行：列数为 ' + parts.length + '，应为 2 列（x_mm,y_mm）。'
        });
        continue;
      }
      var sx = parts[0].trim(), sy = parts[1].trim();
      var x = Number(sx), y = Number(sy);
      if (sx === '' || !isFinite(x)) fieldError(lineNo, 1, sx);
      if (sy === '' || !isFinite(y)) fieldError(lineNo, 2, sy);
      if (isFinite(x) && isFinite(y) && sx !== '' && sy !== '') {
        points.push({ x: x, y: y, row: lineNo });
      }
    }

    return { points: points, errors: errors };
  }

  /* ---------------- 设计点基准校验（质检 / 自动校准共用） ---------------- */
  function collectDesignPoints(input) {
    var design = [];
    var errors = [];
    if (Array.isArray(input)) {
      for (var di = 0; di < input.length; di++) {
        var dpt = input[di] || {};
        var dx = num(dpt.x), dy = num(dpt.y);
        if (!isFinite(dx) || !isFinite(dy)) {
          errors.push({ line: null, message: '设计点基准数据第 ' + (di + 1) + ' 个坐标非法，请重新排版后再质检。' });
          break;
        }
        if (design.length >= MAX_POINTS) {
          errors.push({ line: null, message: '设计点超过 ' + MAX_POINTS + ' 个上限。' });
          break;
        }
        design.push({ x: dx, y: dy, r: isFinite(num(dpt.r)) && num(dpt.r) > 0 ? num(dpt.r) : null });
      }
    } else {
      errors.push({ line: null, message: '缺少设计点基准数据，请先在「排版」模式完成一次成功排版。' });
    }
    return { design: design, errors: errors };
  }

  /* ---------------- 关联半径候选边（质检 / 自动校准共用） ----------------
   * 以指定平移 (offX, offY) 先修正实测坐标（比较坐标 = 变换后实测 + 平移），
   * 返回 design[i] 与 points[j] 距离 <= maxRadius 的候选边 [{i,j,d}]。
   * points 为已经过刚体几何变换（可能含绕中心旋转）的实测点；
   * buildRadiusCandidates 为仅平移的便捷包装（质检纯平移路径 / 旧调用方使用）。
   */
  function buildRadiusCandidatesFor(design, points, maxRadius, offX, offY) {
    var nD = design.length, nM = points.length;
    var r2 = maxRadius * maxRadius;
    var out = [];
    for (var i = 0; i < nD; i++) {
      for (var j = 0; j < nM; j++) {
        var ddx = design[i].x - (points[j].x + offX);
        var ddy = design[i].y - (points[j].y + offY);
        if (ddx * ddx + ddy * ddy <= r2 + 1e-12) {
          out.push({ i: i, j: j, d: Math.sqrt(ddx * ddx + ddy * ddy) });
        }
      }
    }
    return out;
  }

  function buildRadiusCandidates(design, measured, maxRadius, offX, offY) {
    return buildRadiusCandidatesFor(design, measured, maxRadius, offX, offY);
  }

  /* ---------------- 一对一最优匹配（最小费用最大流） ----------------
   * 源点 -> 设计点 -> 实测点 -> 汇点，仅保留距离 <= maxRadius 的候选边。
   * 连续最短路（Dijkstra + 势函数）保证：
   *   流量最大（=匹配对数最多）-> 费用最小（=总欧氏距离最小）->
   *   费用低位编码序号（=稳定决胜，优先使用靠前的设计点与 CSV 行）。
   * 返回 [{i, j, d}]（i/j 为 0 基下标）。
   */
  function solveMatching(nD, nM, candidates) {
    if (nD === 0 || nM === 0 || candidates.length === 0) return [];

    var N = nD + nM + 2;
    var S = 0;
    var T = N - 1;
    var dBase = 1;               // 设计点节点编号基址
    var mBase = 1 + nD;         // 实测点节点编号基址

    // 边用并行数组存储：from/to/cap/cost/rev，并附带 i,j 标记候选边
    var eFrom = [], eTo = [], eCap = [], eCost = [], eRev = [], eI = [], eJ = [];
    var adj = [];
    for (var a = 0; a < N; a++) adj.push([]);

    function addEdge(u, v, cap, cost, i, j) {
      var idx = eFrom.length;
      eFrom.push(u); eTo.push(v); eCap.push(cap); eCost.push(cost);
      eI.push(i == null ? -1 : i); eJ.push(j == null ? -1 : j);
      eRev.push(idx + 1);
      eFrom.push(v); eTo.push(u); eCap.push(0); eCost.push(-cost);
      eI.push(-1); eJ.push(-1);
      eRev.push(idx);
      adj[u].push(idx);
      adj[v].push(idx + 1);
      return idx;
    }

    for (var i = 0; i < nD; i++) addEdge(S, dBase + i, 1, 0n);
    for (var m = 0; m < nM; m++) addEdge(mBase + m, T, 1, 0n);
    // 候选边按设计点序号、再按 CSV 行号顺序加入，保证图遍历本身也是稳定的
    for (var c = 0; c < candidates.length; c++) {
      var cd = candidates[c];
      var dInt = BigInt(Math.round(cd.d * DIST_SCALE));
      var tie = BigInt(cd.i * (nM + 1) + cd.j + 1);
      addEdge(dBase + cd.i, mBase + cd.j, 1, dInt * TIE_SCALE + tie, cd.i, cd.j);
    }

    // 初始势函数：初始残量图含反向负边（费用为 0 或 -cost），Dijkstra 要求约化费用
    // 非负，故先用 SPFA 求源点到各节点的最短路作为初始势（图小，只跑一次）。
    var pot = new Array(N).fill(null);
    (function initPotential() {
      var inQ = new Array(N).fill(false);
      var queue = [S];
      pot[S] = 0n;
      var head = 0;
      while (head < queue.length) {
        var u = queue[head++];
        inQ[u] = false;
        var eds = adj[u];
        for (var k = 0; k < eds.length; k++) {
          var eidx = eds[k];
          if (eCap[eidx] <= 0) continue;
          var v = eTo[eidx];
          var nd = pot[u] + eCost[eidx];
          if (pot[v] === null || nd < pot[v]) {
            pot[v] = nd;
            if (!inQ[v]) { queue.push(v); inQ[v] = true; }
          }
        }
      }
    })();

    // 简易二叉堆：元素 [距离, 节点编号]，同距离按节点编号升序
    var heapD = [], heapN = [];
    function heapPush(d, node) {
      heapD.push(d); heapN.push(node);
      var p = heapD.length - 1;
      while (p > 0) {
        var par = (p - 1) >> 1;
        if (heapD[par] < d || (heapD[par] === d && heapN[par] <= node)) break;
        var td = heapD[par]; heapD[par] = heapD[p]; heapD[p] = td;
        var tn = heapN[par]; heapN[par] = heapN[p]; heapN[p] = tn;
        p = par;
      }
    }
    function heapPop() {
      var d = heapD[0], node = heapN[0];
      var ld = heapD.pop(), ln = heapN.pop();
      if (heapD.length > 0) {
        heapD[0] = ld; heapN[0] = ln;
        var p = 0, len = heapD.length;
        for (;;) {
          var l = 2 * p + 1, r = l + 1, best = p;
          if (l < len && (heapD[l] < heapD[best] || (heapD[l] === heapD[best] && heapN[l] < heapN[best]))) best = l;
          if (r < len && (heapD[r] < heapD[best] || (heapD[r] === heapD[best] && heapN[r] < heapN[best]))) best = r;
          if (best === p) break;
          var td2 = heapD[best]; heapD[best] = heapD[p]; heapD[p] = td2;
          var tn2 = heapN[best]; heapN[best] = heapN[p]; heapN[p] = tn2;
          p = best;
        }
      }
      return { d: d, node: node };
    }

    var flow = 0;
    for (;;) {
      var dist = new Array(N).fill(null);
      var prevV = new Array(N).fill(-1);
      var prevE = new Array(N).fill(-1);
      dist[S] = 0n;
      heapD.length = 0; heapN.length = 0;
      heapPush(0n, S);

      while (heapD.length) {
        var top = heapPop();
        if (top.d !== dist[top.node]) continue;
        var u = top.node;
        var eds = adj[u];
        for (var ei = 0; ei < eds.length; ei++) {
          var eidx = eds[ei];
          if (eCap[eidx] <= 0) continue;
          var v = eTo[eidx];
          var rc = eCost[eidx] + pot[u] - pot[v]; // 约化费用（势函数保证非负）
          var nd = top.d + rc;
          if (dist[v] === null || nd < dist[v]) {
            dist[v] = nd;
            prevV[v] = u;
            prevE[v] = eidx;
            heapPush(nd, v);
          }
        }
      }

      if (dist[T] === null) break; // 无可增广路 -> 已达最大匹配数
      for (var v2 = 0; v2 < N; v2++) {
        if (dist[v2] !== null) pot[v2] += dist[v2];
      }
      // 所有边容量均为 1，每次增广 1 个流量
      var cur = T;
      while (cur !== S) {
        var pe = prevE[cur];
        eCap[pe] -= 1;
        eCap[eRev[pe]] += 1;
        cur = prevV[cur];
      }
      flow++;
    }

    // 容量降为 0 的候选边即最终配对
    var pairs = [];
    for (var q = 0; q < eFrom.length; q++) {
      if (eI[q] >= 0 && eCap[q] === 0) {
        pairs.push({ i: eI[q], j: eJ[q] });
      }
    }
    pairs.sort(function (a, b) { return a.i - b.i; });
    return pairs;
  }

  /* ---------------- 质检主入口 ----------------
   * input:
   *   design        [{x,y,r?}]  最近成功排版的设计点（mm）
   *   csv           string      实测点 CSV 文本
   *   offsetX/Y     number      校准偏移（mm），比较坐标 = 旋转后实测 + 偏移
   *   rotationDeg   number      小角度刚体旋转（°，缺省 0），先绕旋转中心旋转实测点
   *   centerX/Y     number      旋转中心（mm，缺省=板材中心/设计包围盒中心）
   *   tolerance     number      合格公差（mm），配对距离 <= tolerance 判合格
   *   maxRadius     number      最大关联半径（mm），超过不允许配对
   *   plateWidth/Height number  基准板材幅面（SVG 底图/默认旋转中心用，可选）
   */
  function inspect(input) {
    input = input || {};
    var errors = [];

    var offsetX = num(input.offsetX != null && input.offsetX !== '' ? input.offsetX : 0);
    var offsetY = num(input.offsetY != null && input.offsetY !== '' ? input.offsetY : 0);
    var rotationDeg = num(input.rotationDeg != null && input.rotationDeg !== '' ? input.rotationDeg : 0);
    var centerX = num(input.centerX);
    var centerY = num(input.centerY);
    var tolerance = num(input.tolerance != null && input.tolerance !== '' ? input.tolerance : NaN);
    var maxRadius = num(input.maxRadius != null && input.maxRadius !== '' ? input.maxRadius : NaN);
    var plateWidth = num(input.plateWidth);
    var plateHeight = num(input.plateHeight);

    if (!isFinite(offsetX)) errors.push({ line: null, message: 'X 校准偏移必须是数字。' });
    if (!isFinite(offsetY)) errors.push({ line: null, message: 'Y 校准偏移必须是数字。' });
    if (!isFinite(rotationDeg)) errors.push({ line: null, message: '校准旋转角必须是数字（°）。' });
    if (!(Math.abs(rotationDeg) <= 180)) errors.push({ line: null, message: '校准旋转角必须在 ±180° 以内。' });
    if (input.centerX != null && input.centerX !== '' && !isFinite(centerX)) errors.push({ line: null, message: '旋转中心 X 必须是数字（mm）。' });
    if (input.centerY != null && input.centerY !== '' && !isFinite(centerY)) errors.push({ line: null, message: '旋转中心 Y 必须是数字（mm）。' });
    if (!(tolerance > 0)) errors.push({ line: null, message: '合格公差必须为正数（mm）。' });
    if (!(maxRadius > 0)) errors.push({ line: null, message: '最大关联半径必须为正数（mm）。' });

    var collected = collectDesignPoints(input.design);
    var design = collected.design;
    errors.push.apply(errors, collected.errors);

    var parsed = parseMeasuredCsv(typeof input.csv === 'string' ? input.csv : '');
    errors.push.apply(errors, parsed.errors);
    var measured = parsed.points;

    // 旋转中心：显式传入优先，否则取板材中心/设计点包围盒中心
    var center = resolveCenter(design, plateWidth, plateHeight);
    var rotCX = isFinite(centerX) ? centerX : center.cx;
    var rotCY = isFinite(centerY) ? centerY : center.cy;

    var base = {
      ok: false,
      errors: errors,
      params: {
        offsetX: isFinite(offsetX) ? round4(offsetX) : null,
        offsetY: isFinite(offsetY) ? round4(offsetY) : null,
        rotationDeg: isFinite(rotationDeg) ? round4(rotationDeg) : null,
        centerX: round4(rotCX),
        centerY: round4(rotCY),
        tolerance: isFinite(tolerance) ? round4(tolerance) : null,
        maxRadius: isFinite(maxRadius) ? round4(maxRadius) : null
      },
      baseline: {
        count: design.length,
        plateWidth: isFinite(plateWidth) ? plateWidth : null,
        plateHeight: isFinite(plateHeight) ? plateHeight : null
      },
      measuredCount: measured.length,
      pairs: [],
      missing: [],
      extra: [],
      stats: null,
      svg: null,
      csv: null
    };
    if (errors.length) return base;

    // 1. 应用刚体校准：先绕中心旋转，再整体平移，得到实测点的比较坐标
    var rotated = measured.map(function (p) {
      return rotateAbout(p.x, p.y, rotCX, rotCY, rotationDeg);
    });
    var corrected = rotated.map(function (p) {
      return { x: p.x + offsetX, y: p.y + offsetY };
    });

    // 2. 生成半径内候选边（先应用旋转，再应用校准偏移）
    var nD = design.length, nM = measured.length;
    var candidates = buildRadiusCandidatesFor(design, rotated, maxRadius, offsetX, offsetY);

    // 3. 最大匹配数 -> 最小总距离 -> 序号稳定决胜
    var matched = solveMatching(nD, nM, candidates);
    var usedD = {}, usedM = {};
    var pairs = matched.map(function (pm) {
      usedD[pm.i] = true;
      usedM[pm.j] = true;
      var dp = design[pm.i], cp = corrected[pm.j], mp = measured[pm.j];
      var distance = hyp(dp.x, dp.y, cp.x, cp.y);
      return {
        designIndex: pm.i + 1, // 1 基序号，供页面/报告展示
        csvRow: mp.row,        // CSV 物理行号
        designX: round4(dp.x),
        designY: round4(dp.y),
        measuredX: round4(mp.x),
        measuredY: round4(mp.y),
        correctedX: round4(cp.x),
        correctedY: round4(cp.y),
        distance: round4(distance),
        verdict: distance <= tolerance + 1e-9 ? VERDICT.PASS : VERDICT.OFFSET
      };
    });

    var missing = [];
    for (var ii = 0; ii < nD; ii++) {
      if (!usedD[ii]) {
        missing.push({ designIndex: ii + 1, x: round4(design[ii].x), y: round4(design[ii].y) });
      }
    }
    var extra = [];
    for (var jj = 0; jj < nM; jj++) {
      if (!usedM[jj]) {
        extra.push({
          csvRow: measured[jj].row,
          measuredX: round4(measured[jj].x),
          measuredY: round4(measured[jj].y),
          x: round4(corrected[jj].x),
          y: round4(corrected[jj].y)
        });
      }
    }

    // 4. 统计：通过率 = 合格对数 / 设计点总数（缺失即不通过）
    var passCount = pairs.filter(function (p) { return p.verdict === VERDICT.PASS; }).length;
    var offsetCount = pairs.length - passCount;
    var sumDist = 0, maxDist = 0;
    pairs.forEach(function (p) {
      sumDist += p.distance;
      if (p.distance > maxDist) maxDist = p.distance;
    });
    var passRate = nD > 0 ? passCount / nD : (nM === 0 ? 1 : 0);
    var stats = {
      designCount: nD,
      measuredCount: nM,
      matchedCount: pairs.length,
      passCount: passCount,
      offsetCount: offsetCount,
      missingCount: missing.length,
      extraCount: extra.length,
      passRate: passRate,
      passRatePercent: Math.round(passRate * 1000) / 10,
      maxDeviation: pairs.length ? round4(maxDist) : null,
      meanDeviation: pairs.length ? round4(sumDist / pairs.length) : null
    };

    base.ok = true;
    base.pairs = pairs;
    base.missing = missing;
    base.extra = extra;
    base.stats = stats;
    base.svg = buildQcSvg(design, plateWidth, plateHeight, pairs, missing, extra, base.params);
    base.csv = buildReportCsv(pairs, missing, extra, base.params, stats);
    return base;
  }

  /* ---------------- 自动校准：估算全局平移（可选小角度刚体旋转） ----------------
   * input:
   *   design        [{x,y,r?}]  最近成功排版的设计点（mm）
   *   csv           string      实测点 CSV 文本（顺序无须与设计点对应）
   *   maxOffsetX/Y  number      X / Y 最大校准量（mm，须 >= 0）：候选平移两轴均不得超限
   *   maxRadius     number      最大关联半径（mm，须 > 0），复用质检的一对一匹配
   *   maxRotation   number      最大旋转角（°，可选，0…10）：传入即启用小角度刚体校准
   *   angleStep     number      角度步长（°，可选，>0；缺省 0.1°）
   *   plateWidth/Height number  基准板材幅面（mm，可选）：旋转中心取板材几何中心
   *   centerX/Y     number      旋转中心（mm，可选）：显式给出时优先于板材中心
   *
   * 纯平移模式（未传 maxRotation）：候选平移取“设计坐标 i － 实测坐标 j”，
   * 仅保留 |dx| <= maxOffsetX 且 |dy| <= maxOffsetY 者，每个候选跑同一一对一匹配，按
   *   ① 匹配对数最多 → ② 总残差最小 → ③ |dx|+|dy| 最小 → ④ dx、dy 升序
   * 决出唯一结果。
   *
   * 小角度刚体模式（传入 maxRotation）：角度网格为
   *   k=0,±step,±2step,… 且 |k| <= maxRotation（必含 0°，按 1e-6° 去重）；
   * 每个角度先把全部实测点围绕旋转中心旋转，再在同一 X/Y 限幅内枚举候选平移
   * （设计 i − 旋转后实测 j），逐一复用同一一对一匹配，按
   *   ① 匹配对数最多 → ② 总残差（欧氏距离之和）最小 → ③ |旋转角| 最小 →
   *   ④ |dx|+|dy| 最小 → ⑤ dx 升序、dy 升序、角度升序（固定数值顺序）
   * 确定唯一刚体变换。未参与配对的缺失点/多余点不影响任何统计——不是质心差。
   *
   * 返回 { ok, errors, offsetX, offsetY, rotationDeg, centerX, centerY,
   *        matchedCount, totalResidual, designCount, measuredCount,
   *        candidateCount, angleCount }。
   * 无可用候选时 ok=false 且不给 offset/rotation（调用方保留输入框原值并提示）。
   */
  function estimateCalibration(input) {
    input = input || {};
    var errors = [];

    var maxOffsetX = num(input.maxOffsetX != null && input.maxOffsetX !== '' ? input.maxOffsetX : NaN);
    var maxOffsetY = num(input.maxOffsetY != null && input.maxOffsetY !== '' ? input.maxOffsetY : NaN);
    var maxRadius = num(input.maxRadius != null && input.maxRadius !== '' ? input.maxRadius : NaN);
    var hasRotation = input.maxRotation != null && input.maxRotation !== '';
    var maxRotation = num(hasRotation ? input.maxRotation : NaN);
    var angleStep = num(input.angleStep != null && input.angleStep !== ''
      ? input.angleStep : DEFAULT_ANGLE_STEP);
    var centerX = num(input.centerX);
    var centerY = num(input.centerY);
    var plateWidth = num(input.plateWidth);
    var plateHeight = num(input.plateHeight);

    if (!(maxOffsetX >= 0)) errors.push({ line: null, message: 'X 最大校准量必须为不小于 0 的数字（mm）。' });
    if (!(maxOffsetY >= 0)) errors.push({ line: null, message: 'Y 最大校准量必须为不小于 0 的数字（mm）。' });
    if (!(maxRadius > 0)) errors.push({ line: null, message: '最大关联半径必须为正数（mm）。' });
    if (hasRotation) {
      if (!(maxRotation >= 0)) errors.push({ line: null, message: '最大旋转角必须为不小于 0 的数字（°）。' });
      if (isFinite(maxRotation) && maxRotation > MAX_ROTATION_DEG + 1e-12) {
        errors.push({ line: null, message: '小角度刚体校准的最大旋转角不能超过 ' +
          MAX_ROTATION_DEG + '°（收到 ' + round4(maxRotation) + '°）。' });
      }
      if (!(angleStep > 0)) errors.push({ line: null, message: '角度步长必须为正数（°）。' });
      if (isFinite(maxRotation) && isFinite(angleStep) &&
          maxRotation > 0 && angleStep > maxRotation + 1e-12) {
        errors.push({ line: null, message: '角度步长（' + round4(angleStep) +
          '°）不能大于最大旋转角（' + round4(maxRotation) + '°），否则网格只有 0°。' });
      }
    }
    if (input.centerX != null && input.centerX !== '' && !isFinite(centerX)) {
      errors.push({ line: null, message: '旋转中心 X 必须是数字（mm）。' });
    }
    if (input.centerY != null && input.centerY !== '' && !isFinite(centerY)) {
      errors.push({ line: null, message: '旋转中心 Y 必须是数字（mm）。' });
    }

    var collected = collectDesignPoints(input.design);
    var design = collected.design;
    errors.push.apply(errors, collected.errors);

    var parsed = parseMeasuredCsv(typeof input.csv === 'string' ? input.csv : '');
    errors.push.apply(errors, parsed.errors);
    var measured = parsed.points;

    var center = resolveCenter(design, plateWidth, plateHeight);
    var rotCX = isFinite(centerX) ? centerX : center.cx;
    var rotCY = isFinite(centerY) ? centerY : center.cy;

    var result = {
      ok: false,
      errors: errors,
      offsetX: null,
      offsetY: null,
      rotationDeg: null,
      centerX: round4(rotCX),
      centerY: round4(rotCY),
      matchedCount: 0,
      totalResidual: null,
      designCount: design.length,
      measuredCount: measured.length,
      candidateCount: 0,
      angleCount: 0
    };
    if (errors.length) return result;

    if (design.length === 0 || measured.length === 0) {
      result.errors.push({
        line: null,
        message: design.length === 0
          ? '没有设计点基准，无法估算校准量，请先完成一次成功排版。'
          : '实测点 CSV 为空，无法估算校准量。'
      });
      return result;
    }

    var nD = design.length, nM = measured.length;
    if (nD * nM > MAX_RAW_PAIRS) {
      result.errors.push({
        line: null,
        message: '设计点 × 实测点共 ' + nD + '×' + nM + ' 对，超过 ' + MAX_RAW_PAIRS +
          ' 的计算上限，请减少点数后重试。'
      });
      return result;
    }

    // 1. 角度网格：0° 恒在其中，两侧按 step 对称展开，按 1e-6° 量化去重
    var angles = [0];
    if (hasRotation) {
      var nStep = Math.floor((maxRotation + 1e-12) / angleStep);
      var seenAng = Object.create(null);
      seenAng['0'] = true;
      for (var s = 1; s <= nStep; s++) {
        var a = roundDeg(s * angleStep);
        var negKey = String(-a), posKey = String(a);
        if (!seenAng[negKey]) { seenAng[negKey] = true; angles.push(-a); }
        if (!seenAng[posKey]) { seenAng[posKey] = true; angles.push(a); }
      }
      if (angles.length > MAX_ANGLE_CANDIDATES) {
        result.errors.push({
          line: null,
          message: '角度网格共 ' + angles.length + ' 个角度，超过 ' + MAX_ANGLE_CANDIDATES +
            ' 个上限：请增大角度步长或减小最大旋转角。'
        });
        return result;
      }
    }
    result.angleCount = angles.length;

    // 2. 角度 × 平移联合搜索：每个角度先绕中心旋转实测点，再在现有 X/Y 限幅内枚举平移
    var best = null;
    var totalCandidates = 0;
    for (var ai = 0; ai < angles.length; ai++) {
      var angle = angles[ai];
      var points = angle === 0
        ? measured
        : measured.map(function (p) { return rotateAbout(p.x, p.y, rotCX, rotCY, angle); });

      // 候选平移取“设计 i − 旋转后实测 j”，两轴限幅并按 1e-6 mm 量化去重
      var seen = Object.create(null);
      var offsets = [];
      for (var i = 0; i < nD; i++) {
        for (var j = 0; j < nM; j++) {
          var dx = round6(design[i].x - points[j].x);
          var dy = round6(design[i].y - points[j].y);
          if (Math.abs(dx) > maxOffsetX + 1e-9 || Math.abs(dy) > maxOffsetY + 1e-9) continue;
          var key = dx + ',' + dy;
          if (!seen[key]) { seen[key] = true; offsets.push({ dx: dx, dy: dy }); }
        }
      }

      if (offsets.length === 0) continue;
      if (offsets.length > MAX_OFFSET_CANDIDATES) {
        result.errors.push({
          line: null,
          message: '限幅后单个角度仍有 ' + offsets.length + ' 个候选平移，超过 ' +
            MAX_OFFSET_CANDIDATES + ' 个上限：请收紧最大校准量 / 关联半径，或减少点数后重试。'
        });
        return result;
      }
      totalCandidates += offsets.length;
      if (totalCandidates > MAX_TOTAL_RIGID_CANDIDATES) {
        result.errors.push({
          line: null,
          message: '角度 × 平移候选总数超过 ' + MAX_TOTAL_RIGID_CANDIDATES +
            ' 个评估上限：请增大角度步长、收紧最大校准量，或减少点数后重试。'
        });
        return result;
      }

      // 该角度下每个候选复用一对一匹配，按五级优先级与全局 best 比较
      for (var k = 0; k < offsets.length; k++) {
        var off = offsets[k];
        var edges = buildRadiusCandidatesFor(design, points, maxRadius, off.dx, off.dy);
        var matched = solveMatching(nD, nM, edges);
        var total = 0;
        // 直接由配对双方坐标重算距离，与候选边/质检匹配所用表达式一致
        for (var p = 0; p < matched.length; p++) {
          var pm = matched[p];
          total += hyp(design[pm.i].x, design[pm.i].y,
            points[pm.j].x + off.dx, points[pm.j].y + off.dy);
        }
        var absA = Math.abs(angle);
        var l1 = Math.abs(off.dx) + Math.abs(off.dy);

        var take = best === null;
        if (!take && matched.length === best.count) {
          if (total < best.total - 1e-12) {
            take = true;
          } else if (Math.abs(total - best.total) <= 1e-12) {
            if (absA < best.absAngle - 1e-9) {
              take = true;
            } else if (Math.abs(absA - best.absAngle) <= 1e-9) {
              if (l1 < best.l1 - 1e-12) {
                take = true;
              } else if (Math.abs(l1 - best.l1) <= 1e-12) {
                // 固定数值顺序：dx → dy → 角度
                if (off.dx < best.dx - 1e-12 ||
                    (Math.abs(off.dx - best.dx) <= 1e-12 &&
                      (off.dy < best.dy - 1e-12 ||
                       (Math.abs(off.dy - best.dy) <= 1e-12 && angle < best.angle - 1e-9)))) {
                  take = true;
                }
              }
            }
          }
        } else if (!take && matched.length > best.count) {
          take = true;
        }
        if (take) {
          best = {
            dx: off.dx, dy: off.dy, angle: angle, absAngle: absA,
            count: matched.length, total: total, l1: l1
          };
        }
      }
    }
    result.candidateCount = totalCandidates;

    if (best === null) {
      var limitText = '没有落在 X ≤ ' + round4(maxOffsetX) + ' mm、Y ≤ ' + round4(maxOffsetY) +
        ' mm 校准量内的候选平移';
      result.errors.push({
        line: null,
        message: hasRotation
          ? limitText + '：在 ' + angles.length + ' 个搜索角度（±' + round4(maxRotation) +
            '°，步长 ' + round4(angleStep) + '°，围绕板材中心 (' + result.centerX + ',' +
            result.centerY + ') mm 旋转）下均无有效候选，请放大最大校准量/旋转角、' +
            '检查实测 CSV 与关联半径。'
          : limitText + '：请放大最大校准量或检查实测 CSV / 关联半径。'
      });
      return result;
    }

    result.ok = true;
    result.offsetX = round4(best.dx);
    result.offsetY = round4(best.dy);
    result.rotationDeg = round4(best.angle);
    result.matchedCount = best.count;
    result.totalResidual = round4(best.total);
    return result;
  }

  /* ---------------- 叠加 SVG（四类着色） ---------------- */

  var COLORS = {
    pass: '#16a34a',    // 合格：绿
    offset: '#d97706',  // 偏移超差：橙
    missing: '#dc2626', // 缺失：红
    extra: '#7c3aed'    // 多余：紫
  };

  function buildQcSvg(design, plateWidth, plateHeight, pairs, missing, extra, params) {
    // 视口包围盒：板材矩形 ∪ 所有点（含偏移后落到板外的实测点）
    var minX = 0, minY = 0, maxX = isFinite(plateWidth) ? plateWidth : 0;
    var maxY = isFinite(plateHeight) ? plateHeight : 0;
    function expand(x, y) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    design.forEach(function (d) { expand(d.x, d.y); });
    pairs.forEach(function (p) { expand(p.correctedX, p.correctedY); });
    extra.forEach(function (p) { expand(p.x, p.y); });
    if (!(maxX > minX) || !(maxY > minY)) { maxX = minX + 10; maxY = minY + 10; }
    var pad = Math.max(3, round3((maxX - minX) * 0.03));
    minX = round3(minX - pad); minY = round3(minY - pad);
    maxX = round3(maxX + pad); maxY = round3(maxY + pad);
    var W = round3(maxX - minX), H = round3(maxY - minY);

    var defaultR = 0.75; // 无凸点半径信息时的绘制半径
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" ' +
      'viewBox="' + minX + ' ' + minY + ' ' + W + ' ' + H + '" data-unit="mm" ' +
      'data-rotation-deg="' + params.rotationDeg + '" data-center-x-mm="' + params.centerX +
      '" data-center-y-mm="' + params.centerY + '">');
    out.push('  <desc>压印质检叠加图：绿色=合格，橙色=偏移超差，红色=缺失，紫色=多余；' +
      '圆形为设计点，菱形为应用刚体校准（旋转 ' + params.rotationDeg + '° 后平移 ' +
      params.offsetX + ',' + params.offsetY + ' mm）后的实测点（data-measured-x/y 为原始坐标），' +
      '细线为配对连线；旋转中心 (' + params.centerX + ',' + params.centerY + ') mm。</desc>');

    if (isFinite(plateWidth) && isFinite(plateHeight)) {
      out.push('  <rect x="0" y="0" width="' + plateWidth + '" height="' + plateHeight +
        '" fill="#ffffff" stroke="#333333" stroke-width="0.3"/>');
    } else {
      out.push('  <rect x="' + minX + '" y="' + minY + '" width="' + W + '" height="' + H +
        '" fill="#ffffff" stroke="none"/>');
    }

    var passN = 0, offN = 0, misN = missing.length, extN = extra.length;

    // 配对连线（先画，压在点标记之下）
    pairs.forEach(function (p) {
      var col = p.verdict === VERDICT.PASS ? COLORS.pass : COLORS.offset;
      if (p.verdict === VERDICT.PASS) passN++; else offN++;
      out.push('  <line x1="' + p.designX + '" y1="' + p.designY + '" x2="' + p.correctedX +
        '" y2="' + p.correctedY + '" stroke="' + col + '" stroke-width="0.12" opacity="0.65"/>');
    });

    // 配对：设计点（圆）+ 实测点（菱形）
    pairs.forEach(function (p) {
      var dp = design[p.designIndex - 1] || {};
      var r = dp.r != null ? dp.r : defaultR;
      var col = p.verdict === VERDICT.PASS ? COLORS.pass : COLORS.offset;
      var s = Math.max(0.5, r * 1.5); // 菱形半边长
      out.push('  <circle cx="' + p.designX + '" cy="' + p.designY + '" r="' + round3(r) +
        '" fill="#ffffff" stroke="' + col + '" stroke-width="0.22" data-design-index="' +
        p.designIndex + '" data-csv-row="' + p.csvRow + '" data-verdict="' + p.verdict + '"/>');
      out.push('  <rect x="' + round3(p.correctedX - s) + '" y="' + round3(p.correctedY - s) +
        '" width="' + round3(2 * s) + '" height="' + round3(2 * s) +
        '" transform="rotate(45 ' + p.correctedX + ' ' + p.correctedY + ')" fill="' + col +
        '" opacity="0.85" data-design-index="' + p.designIndex + '" data-csv-row="' +
        p.csvRow + '" data-verdict="' + p.verdict + '" data-measured-x="' + p.measuredX +
        '" data-measured-y="' + p.measuredY + '"/>');
    });

    // 缺失：只有红色设计圆 + 叉
    missing.forEach(function (m) {
      var dp = design[m.designIndex - 1] || {};
      var r = dp.r != null ? dp.r : defaultR;
      out.push('  <circle cx="' + m.x + '" cy="' + m.y + '" r="' + round3(r) +
        '" fill="#ffffff" stroke="' + COLORS.missing + '" stroke-width="0.22" data-design-index="' +
        m.designIndex + '" data-verdict="missing"/>');
      out.push('  <line x1="' + round3(m.x - r) + '" y1="' + round3(m.y - r) + '" x2="' +
        round3(m.x + r) + '" y2="' + round3(m.y + r) + '" stroke="' + COLORS.missing +
        '" stroke-width="0.18"/>');
      out.push('  <line x1="' + round3(m.x + r) + '" y1="' + round3(m.y - r) + '" x2="' +
        round3(m.x - r) + '" y2="' + round3(m.y + r) + '" stroke="' + COLORS.missing +
        '" stroke-width="0.18"/>');
    });

    // 多余：只有紫色实测菱形
    extra.forEach(function (g) {
      var s = defaultR;
      out.push('  <rect x="' + round3(g.x - s) + '" y="' + round3(g.y - s) +
        '" width="' + round3(2 * s) + '" height="' + round3(2 * s) +
        '" transform="rotate(45 ' + g.x + ' ' + g.y + ')" fill="' + COLORS.extra +
        '" opacity="0.85" data-csv-row="' + g.csvRow + '" data-verdict="extra"' +
        ' data-measured-x="' + g.measuredX + '" data-measured-y="' + g.measuredY + '"/>');
    });

    out.push('</svg>');
    return out.join('\n');
  }

  /* ---------------- CSV 报告下载 ---------------- */

  function csvCell(v) {
    var s = v == null ? '' : String(v);
    if (/[",\n\r]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function buildReportCsv(pairs, missing, extra, params, stats) {
    var head = [
      'design_index', 'design_x_mm', 'design_y_mm',
      'csv_row', 'measured_x_mm', 'measured_y_mm',
      'corrected_x_mm', 'corrected_y_mm', 'distance_mm', 'conclusion', 'rotation_deg'
    ];
    var rows = [head.map(csvCell).join(',')];

    function pushRow(vals) { rows.push(vals.map(csvCell).join(',')); }

    // 每行同时给出原始实测坐标（measured_*）、校正坐标（corrected_*）与本报告使用的旋转角
    pairs.forEach(function (p) {
      pushRow([
        p.designIndex, p.designX, p.designY,
        p.csvRow, p.measuredX, p.measuredY,
        p.correctedX, p.correctedY, p.distance,
        VERDICT_LABEL[p.verdict], params.rotationDeg
      ]);
    });
    missing.forEach(function (m) {
      pushRow([m.designIndex, m.x, m.y, '', '', '', '', '', '', VERDICT_LABEL.missing, params.rotationDeg]);
    });
    extra.forEach(function (g) {
      pushRow(['', '', '', g.csvRow, g.measuredX, g.measuredY, g.x, g.y, '', VERDICT_LABEL.extra, params.rotationDeg]);
    });

    // 末尾附汇总行（键值列形式，不影响明细表导入）
    rows.push('');
    rows.push(['# summary', 'design_count', 'measured_count', 'matched', 'pass', 'offset_overrun', 'missing', 'extra', 'pass_rate_percent', 'max_deviation_mm', 'mean_deviation_mm'].map(csvCell).join(','));
    rows.push(['',
      stats.designCount, stats.measuredCount, stats.matchedCount,
      stats.passCount, stats.offsetCount, stats.missingCount, stats.extraCount,
      stats.passRatePercent,
      stats.maxDeviation == null ? '' : stats.maxDeviation,
      stats.meanDeviation == null ? '' : stats.meanDeviation
    ].map(csvCell).join(','));
    rows.push(['# params', 'offset_x_mm', 'offset_y_mm', 'rotation_deg', 'center_x_mm', 'center_y_mm', 'tolerance_mm', 'max_radius_mm'].map(csvCell).join(','));
    rows.push(['', params.offsetX, params.offsetY, params.rotationDeg, params.centerX, params.centerY, params.tolerance, params.maxRadius].map(csvCell).join(','));

    return '\uFEFF' + rows.join('\r\n');
  }

  return {
    MAX_POINTS: MAX_POINTS,
    VERDICT: VERDICT,
    VERDICT_LABEL: VERDICT_LABEL,
    COLORS: COLORS,
    parseMeasuredCsv: parseMeasuredCsv,
    solveMatching: solveMatching,
    inspect: inspect,
    estimateCalibration: estimateCalibration,
    buildQcSvg: buildQcSvg,
    buildReportCsv: buildReportCsv
  };
});
