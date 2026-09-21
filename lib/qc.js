/*
 * 压印质检（Embossing QC）核心模块。
 * 同时供 Node 服务端与浏览器前端使用（UMD）。
 *
 * 质检流程：
 *   1. 以最近一次成功排版的设计凸点为基准；
 *   2. 解析用户粘贴的实测凸点 CSV（x_mm,y_mm），解析错误定位到具体行号；
 *   3. 对实测点先围绕板材中心做小角度刚体旋转 rotation（度，逆时针为正），再应用
 *      校准偏移 (offsetX, offsetY)：比较坐标 = R(rotation)·(实测−中心) + 中心 + 偏移；
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
 * 小角度刚体校准：额外传入 maxAngle（最大旋转角，度，≥0，小角度）与
 * angleStep（角度步长，>0）后启用。角度在 [-maxAngle, maxAngle] 内按步长枚举
 * （含 0°，按 1e-9 度去重）；每个候选角度先把实测点围绕板材中心
 * （plateWidth/Height 之半，缺失时用设计点包围盒中心）做刚体旋转，再在现有
 * X/Y 限幅内枚举候选平移，即“角度 × 平移”联合搜索。每个（角度, 平移）候选
 * 复用同一一对一匹配，按
 *   ① 匹配对数最多 → ② 配对总残差最小 → ③ 旋转绝对值最小（偏好不转）→
 *   ④ |dx|+|dy| 最小 → ⑤ dx 升序、dy 升序、角度升序
 * 决出唯一刚体参数。不传 maxAngle/angleStep 时完全走旧的纯平移流程。
 *
 * 坐标单位均为毫米 mm，原点在板材左上角，x 向右、y 向下。
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
  var MAX_OFFSET_CANDIDATES = 20000; // 限幅去重后的候选平移上限

  // 小角度刚体校准的规模保护（每个角度都要重跑一遍候选枚举与匹配）
  var MAX_RIGID_ANGLE = 15;        // 小角度搜索的最大旋转角（度）
  var MAX_RIGID_ANGLE_STEPS = 201; // 枚举角度个数上限（含 0° 与两侧端点）
  var MAX_RIGID_EVALUATIONS = 200000; // “角度 × 平移”候选评估总数上限
  // 每角度都要建一次 nD×nM 坐标差矩阵：角度数 × nD × nM 的总预算上限
  var MAX_RIGID_PAIR_BUDGET = 6000000;

  /* ---------------- 工具 ---------------- */

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }
  function round4(n) {
    var v = Math.round(n * 10000) / 10000;
    return v === 0 ? 0 : v; // 归一化 -0（如极小残差四舍五入后）
  }
  // 平移候选统一量化到 1e-6 mm 后再去重/比较，消除浮点尾差导致的伪重复候选
  function round6(n) { return Math.round(n * 1000000) / 1000000; }

  function hyp(ax, ay, bx, by) {
    var dx = ax - bx, dy = ay - by;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // 角度（度）-> 弧度
  function deg2rad(deg) { return deg * Math.PI / 180; }

  /* 旋转中心：优先板材幅面中心；缺少幅面（或非正数）时退化为设计点包围盒中心；
   * 无设计点时退化为原点。质检与刚体校准必须使用同一中心，校准结果才能原样写回。
   */
  function resolveCenter(design, plateWidth, plateHeight) {
    if (isFinite(plateWidth) && plateWidth > 0 &&
        isFinite(plateHeight) && plateHeight > 0) {
      return { cx: plateWidth / 2, cy: plateHeight / 2 };
    }
    if (design.length === 0) return { cx: 0, cy: 0 };
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var i = 0; i < design.length; i++) {
      var p = design[i];
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return { cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 };
  }

  // 实测点围绕中心旋转 angleDeg 度（逆时针为正）后，再叠加平移 (offX, offY)
  function transformPoint(x, y, center, angleDeg, offX, offY) {
    if (angleDeg === 0) return { x: x + offX, y: y + offY };
    var a = deg2rad(angleDeg);
    var cos = Math.cos(a), sin = Math.sin(a);
    var rx = x - center.cx, ry = y - center.cy;
    return {
      x: center.cx + cos * rx - sin * ry + offX,
      y: center.cy + sin * rx + cos * ry + offY
    };
  }

  // 生成整组实测点的比较坐标（旋转 + 平移）
  function transformAll(measured, center, angleDeg, offX, offY) {
    var out = new Array(measured.length);
    for (var j = 0; j < measured.length; j++) {
      out[j] = transformPoint(measured[j].x, measured[j].y, center, angleDeg, offX, offY);
    }
    return out;
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
   * 先围绕 center 旋转 angleDeg（度，0 表示不转），再以指定平移 (offX, offY)
   * 修正实测坐标（比较坐标 = R·(实测−中心) + 中心 + 平移），
   * 返回 design[i] 与变换后实测点距离 <= maxRadius 的候选边 [{i,j,d}]。
   */
  function buildRadiusCandidates(design, measured, maxRadius, offX, offY, center, angleDeg) {
    center = center || { cx: 0, cy: 0 };
    angleDeg = angleDeg || 0;
    var nD = design.length, nM = measured.length;
    var r2 = maxRadius * maxRadius;
    var cos = 1, sin = 0;
    if (angleDeg !== 0) {
      var a = deg2rad(angleDeg);
      cos = Math.cos(a); sin = Math.sin(a);
    }
    var out = [];
    for (var i = 0; i < nD; i++) {
      for (var j = 0; j < nM; j++) {
        var mp = measured[j];
        var rx = mp.x - center.cx, ry = mp.y - center.cy;
        var cxm = angleDeg === 0 ? mp.x : center.cx + cos * rx - sin * ry;
        var cym = angleDeg === 0 ? mp.y : center.cy + sin * rx + cos * ry;
        var ddx = design[i].x - (cxm + offX);
        var ddy = design[i].y - (cym + offY);
        if (ddx * ddx + ddy * ddy <= r2 + 1e-12) {
          out.push({ i: i, j: j, d: Math.sqrt(ddx * ddx + ddy * ddy) });
        }
      }
    }
    return out;
  }

  /* 刚体校准专用：先把实测点围绕 center 旋转 angleDeg（不平移），预算
   * 设计点 × 旋转后实测点的坐标差分量（枚举候选平移用），并以 maxRadius 为桶宽
   * 对旋转后实测点建立整数索引的一维网格桶（半径查询只看相邻 3×3 桶，避免每个
   * 候选平移都朴素扫描 nD×nM 全对点对）。同一角度下旋转/分量/桶只构建一次。
   * bx = 设计x − 旋转后实测x。
   */
  function buildPairwiseMatrix(design, measured, center, angleDeg, maxRadius) {
    var nD = design.length, nM = measured.length;
    var rotated = angleDeg === 0 ? measured : transformAll(measured, center, angleDeg, 0, 0);

    var bx = new Array(nD), by = new Array(nD);
    for (var i = 0; i < nD; i++) {
      var rxArr = new Array(nM), ryArr = new Array(nM);
      var dxi = design[i].x, dyi = design[i].y;
      for (var j = 0; j < nM; j++) {
        rxArr[j] = dxi - rotated[j].x;
        ryArr[j] = dyi - rotated[j].y;
      }
      bx[i] = rxArr; by[i] = ryArr;
    }

    // 网格桶：桶宽 = maxRadius，相距 <= radius 的点桶索引差至多 1。
    // 用整数一维索引 (gx-gxMin)*nCols+(gy-gyMin)，避免字符串键的哈希开销。
    var cell = maxRadius > 0 ? maxRadius : 1;
    var gxOf = new Array(nM), gyOf = new Array(nM);
    var gxMin = Infinity, gyMin = Infinity, gxMax = -Infinity, gyMax = -Infinity;
    for (var t = 0; t < nM; t++) {
      var gx = Math.floor(rotated[t].x / cell);
      var gy = Math.floor(rotated[t].y / cell);
      gxOf[t] = gx; gyOf[t] = gy;
      if (gx < gxMin) gxMin = gx;
      if (gx > gxMax) gxMax = gx;
      if (gy < gyMin) gyMin = gy;
      if (gy > gyMax) gyMax = gy;
    }
    var nCols = gyMax - gyMin + 1;
    var nRows = gxMax - gxMin + 1;
    var grid = new Array(nRows * nCols); // 每格为实测点下标的数组（懒分配）
    for (var jj = 0; jj < nM; jj++) {
      var idx = (gxOf[jj] - gxMin) * nCols + (gyOf[jj] - gyMin);
      var cellArr = grid[idx];
      if (!cellArr) { cellArr = []; grid[idx] = cellArr; }
      cellArr.push(jj);
    }

    return {
      bx: bx, by: by, grid: grid,
      gxMin: gxMin, gyMin: gyMin, nCols: nCols, nRows: nRows, cell: cell
    };
  }

  // 给定预算矩阵与候选平移 (offX,offY)，筛出距离 <= maxRadius 的候选边。
  // 查询中心为“设计点 − 平移”（旋转后实测点应落在此处半径内），只遍历相邻 3×3
  // 桶；精确判定仍是同一平方距离表达式，故边集在“是否成对/距离”上与朴素全对扫描
  // 完全一致（网格只做空间索引，不改变任何配对结果）。
  function edgesFromMatrix(matrix, design, nD, nM, maxRadius, offX, offY) {
    var r2 = maxRadius * maxRadius;
    var bx = matrix.bx, by = matrix.by, grid = matrix.grid;
    var gxMin = matrix.gxMin, gyMin = matrix.gyMin, nCols = matrix.nCols, nRows = matrix.nRows;
    var cell = matrix.cell;
    var out = [];
    var colMax = gyMin + nCols - 1, rowMax = gxMin + nRows - 1;
    for (var i = 0; i < nD; i++) {
      var qx = design[i].x - offX;
      var qy = design[i].y - offY;
      var gxc = Math.floor(qx / cell);
      var gyc = Math.floor(qy / cell);
      var g0 = gxc - 1, g1 = gxc + 1, h0 = gyc - 1, h1 = gyc + 1;
      if (g0 < gxMin) g0 = gxMin;
      if (g1 > rowMax) g1 = rowMax;
      if (h0 < gyMin) h0 = gyMin;
      if (h1 > colMax) h1 = colMax;
      for (var gx = g0; gx <= g1; gx++) {
        var rowBase = (gx - gxMin) * nCols;
        for (var gy = h0; gy <= h1; gy++) {
          var cellArr = grid[rowBase + (gy - gyMin)];
          if (!cellArr) continue;
          for (var b = 0; b < cellArr.length; b++) {
            var j = cellArr[b];
            var ex = bx[i][j] - offX, ey = by[i][j] - offY;
            if (ex * ex + ey * ey <= r2 + 1e-12) {
              out.push({ i: i, j: j, d: Math.sqrt(ex * ex + ey * ey) });
            }
          }
        }
      }
    }
    return out;
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
   *   rotation      number      小角度刚体旋转（度，逆时针为正，缺省/空 = 0）
   *   tolerance     number      合格公差（mm），配对距离 <= tolerance 判合格
   *   maxRadius     number      最大关联半径（mm），超过不允许配对
   *   plateWidth/Height number  基准板材幅面（旋转中心与 SVG 底图用，可选）
   */
  function inspect(input) {
    input = input || {};
    var errors = [];

    var offsetX = num(input.offsetX != null && input.offsetX !== '' ? input.offsetX : 0);
    var offsetY = num(input.offsetY != null && input.offsetY !== '' ? input.offsetY : 0);
    var rotation = num(input.rotation != null && input.rotation !== '' ? input.rotation : 0);
    var tolerance = num(input.tolerance != null && input.tolerance !== '' ? input.tolerance : NaN);
    var maxRadius = num(input.maxRadius != null && input.maxRadius !== '' ? input.maxRadius : NaN);
    var plateWidth = num(input.plateWidth);
    var plateHeight = num(input.plateHeight);

    if (!isFinite(offsetX)) errors.push({ line: null, message: 'X 校准偏移必须是数字。' });
    if (!isFinite(offsetY)) errors.push({ line: null, message: 'Y 校准偏移必须是数字。' });
    if (!isFinite(rotation)) errors.push({ line: null, message: '校准旋转角必须是数字（度）。' });
    if (!(tolerance > 0)) errors.push({ line: null, message: '合格公差必须为正数（mm）。' });
    if (!(maxRadius > 0)) errors.push({ line: null, message: '最大关联半径必须为正数（mm）。' });

    var collected = collectDesignPoints(input.design);
    var design = collected.design;
    errors.push.apply(errors, collected.errors);

    var parsed = parseMeasuredCsv(typeof input.csv === 'string' ? input.csv : '');
    errors.push.apply(errors, parsed.errors);
    var measured = parsed.points;

    var center = resolveCenter(design, plateWidth, plateHeight);

    var base = {
      ok: false,
      errors: errors,
      params: {
        offsetX: isFinite(offsetX) ? round4(offsetX) : null,
        offsetY: isFinite(offsetY) ? round4(offsetY) : null,
        rotation: isFinite(rotation) ? round4(rotation) : null,
        tolerance: isFinite(tolerance) ? round4(tolerance) : null,
        maxRadius: isFinite(maxRadius) ? round4(maxRadius) : null
      },
      baseline: {
        count: design.length,
        plateWidth: isFinite(plateWidth) ? plateWidth : null,
        plateHeight: isFinite(plateHeight) ? plateHeight : null
      },
      transform: {
        centerX: design.length || (isFinite(plateWidth) && plateWidth > 0) ? round4(center.cx) : null,
        centerY: design.length || (isFinite(plateHeight) && plateHeight > 0) ? round4(center.cy) : null
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

    // 1. 围绕板材中心做小角度旋转，再应用校准偏移，得到实测点的比较坐标
    var corrected = transformAll(measured, center, rotation, offsetX, offsetY);

    // 2. 生成半径内候选边（先旋转、再应用校准偏移）
    var nD = design.length, nM = measured.length;
    var candidates = buildRadiusCandidates(design, measured, maxRadius, offsetX, offsetY, center, rotation);

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
    base.svg = buildQcSvg(design, plateWidth, plateHeight, pairs, missing, extra, base.params, center);
    base.csv = buildReportCsv(pairs, missing, extra, base.params, stats, center);
    return base;
  }

  /* ---------------- 自动校准：全局平移 / 小角度刚体 ----------------
   * input:
   *   design        [{x,y,r?}]  最近成功排版的设计点（mm）
   *   csv           string      实测点 CSV 文本（顺序无须与设计点对应）
   *   maxOffsetX/Y  number      X / Y 最大校准量（mm，须 >= 0）：候选平移两轴均不得超限
   *   maxRadius     number      最大关联半径（mm，须 > 0），复用质检的一对一匹配
   *   maxAngle      number      可选：最大旋转角（度，须 >= 0 且为小角度）。
   *                             与 angleStep 同时提供时启用“角度 × 平移”联合搜索；
   *                             二者都不传时完全沿用旧的纯平移估算（向后兼容）。
   *   angleStep     number      可选：角度搜索步长（度，须 > 0）
   *   plateWidth/Height number  板材幅面（mm）：旋转中心取幅面中心；缺省时取设计点包围盒中心
   *
   * 纯平移（旧）：候选平移取“设计坐标 i － 实测坐标 j”，仅保留两轴限幅内者，
   * 每个候选跑同一一对一匹配，按
   *   ① 匹配对数最多 → ② 总残差最小 → ③ |dx|+|dy| 最小 → ④ dx 升序、再 dy 升序
   * 决胜。
   *
   * 刚体（新）：角度在 [-maxAngle, maxAngle] 内按 angleStep 枚举（含 0°），
   * 每个角度先把实测点围绕板材中心旋转，再在 X/Y 限幅内枚举候选平移（规则同上），
   * 每个（角度, 平移）候选跑同一一对一匹配，按
   *   ① 匹配对数最多 → ② 总残差最小 → ③ |角度| 最小（尽量不转）→
   *   ④ |dx|+|dy| 最小 → ⑤ dx 升序、dy 升序、角度升序
   * 决胜。未参与配对的缺失/多余点不影响统计——不是质心差。
   *
   * 返回 { ok, errors, offsetX, offsetY, rotation, centerX, centerY,
   *        matchedCount, totalResidual, designCount, measuredCount,
   *        candidateCount, rigidMode, angleCount }。
   * 无可用候选时 ok=false 且不给 offset/rotation（由调用方保留输入框原值并提示）。
   */
  function estimateCalibration(input) {
    input = input || {};
    var errors = [];

    var maxOffsetX = num(input.maxOffsetX != null && input.maxOffsetX !== '' ? input.maxOffsetX : NaN);
    var maxOffsetY = num(input.maxOffsetY != null && input.maxOffsetY !== '' ? input.maxOffsetY : NaN);
    var maxRadius = num(input.maxRadius != null && input.maxRadius !== '' ? input.maxRadius : NaN);
    var plateWidth = num(input.plateWidth);
    var plateHeight = num(input.plateHeight);

    // 角度参数：两者皆空 -> 旧纯平移流程；只传其一 -> 参数错误（避免静默忽略）
    var hasMaxAngle = input.maxAngle != null && input.maxAngle !== '';
    var hasAngleStep = input.angleStep != null && input.angleStep !== '';
    var maxAngle = num(hasMaxAngle ? input.maxAngle : NaN);
    var angleStep = num(hasAngleStep ? input.angleStep : NaN);
    var rigidMode = hasMaxAngle || hasAngleStep;
    if (hasMaxAngle && !(maxAngle >= 0)) errors.push({ line: null, message: '最大旋转角必须为不小于 0 的数字（度）。' });
    if (rigidMode && !(angleStep > 0)) errors.push({ line: null, message: '角度步长必须为正数（度）。' });
    if (rigidMode && (maxAngle > MAX_RIGID_ANGLE + 1e-12)) {
      errors.push({
        line: null,
        message: '最大旋转角 ' + round4(maxAngle) + '° 超出小角度刚体校准允许范围（≤ ' +
          MAX_RIGID_ANGLE + '°），请缩小最大旋转角后重试。'
      });
    }

    if (!(maxOffsetX >= 0)) errors.push({ line: null, message: 'X 最大校准量必须为不小于 0 的数字（mm）。' });
    if (!(maxOffsetY >= 0)) errors.push({ line: null, message: 'Y 最大校准量必须为不小于 0 的数字（mm）。' });
    if (!(maxRadius > 0)) errors.push({ line: null, message: '最大关联半径必须为正数（mm）。' });

    var collected = collectDesignPoints(input.design);
    var design = collected.design;
    errors.push.apply(errors, collected.errors);

    var parsed = parseMeasuredCsv(typeof input.csv === 'string' ? input.csv : '');
    errors.push.apply(errors, parsed.errors);
    var measured = parsed.points;

    var result = {
      ok: false,
      errors: errors,
      offsetX: null,
      offsetY: null,
      rotation: null,
      centerX: null,
      centerY: null,
      matchedCount: 0,
      totalResidual: null,
      designCount: design.length,
      measuredCount: measured.length,
      candidateCount: 0,
      rigidMode: rigidMode,
      angleCount: rigidMode ? 0 : null
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

    var center = resolveCenter(design, plateWidth, plateHeight);
    result.centerX = round4(center.cx);
    result.centerY = round4(center.cy);

    if (!rigidMode) {
      return estimateTranslationOnly(result, design, measured, nD, nM,
        maxOffsetX, maxOffsetY, maxRadius);
    }
    return estimateRigid(result, design, measured, nD, nM,
      maxOffsetX, maxOffsetY, maxRadius, maxAngle, angleStep, center);
  }

  /* 纯平移估算（旧流程，行为与历史版本完全一致；rotation 恒为 0） */
  var center0 = { cx: 0, cy: 0 }; // 纯平移流程角度为 0，旋转中心不参与计算
  function estimateTranslationOnly(result, design, measured, nD, nM,
                                   maxOffsetX, maxOffsetY, maxRadius) {
    // 1. 枚举候选平移（设计 i − 实测 j），两轴限幅并按 1e-6 mm 量化去重
    var seen = Object.create(null);
    var offsets = [];
    for (var i = 0; i < nD; i++) {
      for (var j = 0; j < nM; j++) {
        var dx = round6(design[i].x - measured[j].x);
        var dy = round6(design[i].y - measured[j].y);
        if (Math.abs(dx) > maxOffsetX + 1e-9 || Math.abs(dy) > maxOffsetY + 1e-9) continue;
        var key = dx + ',' + dy;
        if (!seen[key]) { seen[key] = true; offsets.push({ dx: dx, dy: dy }); }
      }
    }
    result.candidateCount = offsets.length;

    if (offsets.length === 0) {
      result.errors.push({
        line: null,
        message: '没有落在 X ≤ ' + round4(maxOffsetX) + ' mm、Y ≤ ' + round4(maxOffsetY) +
          ' mm 校准量内的候选平移：请放大最大校准量或检查实测 CSV / 关联半径。'
      });
      return result;
    }
    if (offsets.length > MAX_OFFSET_CANDIDATES) {
      result.errors.push({
        line: null,
        message: '限幅后仍有 ' + offsets.length + ' 个候选平移，超过 ' + MAX_OFFSET_CANDIDATES +
          ' 个上限：请收紧最大校准量 / 关联半径，或减少点数后重试。'
      });
      return result;
    }

    // 2. 每个候选复用一对一匹配，按四级优先级选出唯一结果
    var best = null;
    for (var k = 0; k < offsets.length; k++) {
      var off = offsets[k];
      var matched = matchFor(design, measured, maxRadius, center0, 0, off.dx, off.dy);
      var total = matchedResidual(design, measured, center0, 0, off.dx, off.dy, matched);
      var l1 = Math.abs(off.dx) + Math.abs(off.dy);

      if (best === null ||
          matched.length > best.count ||
          (matched.length === best.count && total < best.total - 1e-12) ||
          (matched.length === best.count && Math.abs(total - best.total) <= 1e-12 &&
            (l1 < best.l1 - 1e-12 ||
             (Math.abs(l1 - best.l1) <= 1e-12 &&
              (off.dx < best.dx - 1e-12 ||
               (Math.abs(off.dx - best.dx) <= 1e-12 && off.dy < best.dy - 1e-12)))))) {
        best = { angle: 0, dx: off.dx, dy: off.dy, count: matched.length, total: total, l1: l1 };
      }
    }

    return finalizeBest(result, best);
  }

  /* ---- 校准专用快速评分（候选很多时逐个跑 BigInt 最小费用流过慢） ----
   * 评分只需「最大匹配对数 + 该对数下的最小总残差」，不需要 inspect 的序号决胜，
   * 因此分两级：
   *   1) Hopcroft–Karp 只求最大基数（O(E√V)），匹配数打不过当前最优即廉价淘汰；
   *   2) 仅当基数打平/刷新当前最优时，才跑 Number 版最小费用最大流求最小残差。
   * 结果与“每个候选都跑精确最小费用流”完全一致（最终决胜仍用精确残差）。
   * 注意：不能用“度为 1 就强制配对”的剥叶近似求残差——该边只在基数意义下可扩展
   * 为某个最大匹配，并不保证属于总费用最小的那个（如唯一邻边距离反而更大时）。
   */

  // 由候选边构造按设计点索引的邻接表
  function adjacencyByDesign(nD, edges) {
    var adjD = new Array(nD);
    for (var i = 0; i < nD; i++) adjD[i] = [];
    for (var e = 0; e < edges.length; e++) adjD[edges[e].i].push(edges[e]);
    return adjD;
  }

  // Hopcroft–Karp 最大基数匹配（只求对数）。返回匹配数。
  function hopcroftKarp(nD, nM, edges) {
    var adjD = adjacencyByDesign(nD, edges);
    var pairM = new Array(nM).fill(-1);
    var pairD = new Array(nD).fill(-1);
    var dist = new Array(nD);

    function bfs() {
      var queue = [], head = 0, found = false;
      for (var u = 0; u < nD; u++) {
        if (pairD[u] < 0) { dist[u] = 0; queue.push(u); } else dist[u] = -1;
      }
      while (head < queue.length) {
        var v = queue[head++];
        var row = adjD[v];
        for (var k = 0; k < row.length; k++) {
          var w = pairM[row[k].j];
          if (w < 0) found = true;
          else if (dist[w] < 0) { dist[w] = dist[v] + 1; queue.push(w); }
        }
      }
      return found;
    }
    function dfs(u) {
      var row = adjD[u];
      for (var k = 0; k < row.length; k++) {
        var j = row[k].j, w = pairM[j];
        if (w < 0 || (dist[w] === dist[u] + 1 && dfs(w))) {
          pairD[u] = j; pairM[j] = u; return true;
        }
      }
      dist[u] = -1;
      return false;
    }

    var matching = 0;
    while (bfs()) {
      for (var u = 0; u < nD; u++) {
        if (pairD[u] < 0 && dfs(u)) matching++;
      }
    }
    return matching;
  }

  // Number 版最小费用最大流（费用直接用距离 mm；仅校准打分用）。
  // 返回 { count, total }。无 BigInt/SPFA：源边费用全 0，初始势全 0 即可保证
  // 首轮约化费用非负，后续势随最短路更新。
  function minCostMatch(nD, nM, edges) {
    if (nD === 0 || nM === 0 || edges.length === 0) return { count: 0, total: 0 };
    var N = nD + nM + 2, S = 0, T = N - 1;
    var dB = 1, mB = 1 + nD;
    var eTo = [], eCap = [], eCost = [], eRev = [], adj = [];
    for (var a = 0; a < N; a++) adj.push([]);
    function addEdge(u, v, cap, cost) {
      var idx = eTo.length;
      eTo.push(v); eCap.push(cap); eCost.push(cost); eRev.push(idx + 1);
      eTo.push(u); eCap.push(0); eCost.push(-cost); eRev.push(idx);
      adj[u].push(idx); adj[v].push(idx + 1);
    }
    for (var i = 0; i < nD; i++) addEdge(S, dB + i, 1, 0);
    for (var m = 0; m < nM; m++) addEdge(mB + m, T, 1, 0);
    for (var c = 0; c < edges.length; c++) {
      addEdge(dB + edges[c].i, mB + edges[c].j, 1, edges[c].d);
    }

    var pot = new Array(N).fill(0);
    var flow = 0, total = 0;
    for (;;) {
      var dist = new Array(N).fill(Infinity);
      var prevV = new Array(N).fill(-1), prevE = new Array(N).fill(-1);
      dist[S] = 0;
      // 简单二叉堆 [d,node]
      var hd = [], hn = [];
      function push(d, node) {
        hd.push(d); hn.push(node);
        var p = hd.length - 1;
        while (p > 0) {
          var par = (p - 1) >> 1;
          if (hd[par] < d || (hd[par] === d && hn[par] <= node)) break;
          var td = hd[par]; hd[par] = hd[p]; hd[p] = td;
          var tn = hn[par]; hn[par] = hn[p]; hn[p] = tn;
          p = par;
        }
      }
      function pop() {
        var d = hd[0], node = hn[0], ld = hd.pop(), ln = hn.pop();
        if (hd.length > 0) {
          hd[0] = ld; hn[0] = ln;
          var p = 0, len = hd.length;
          for (;;) {
            var l = 2 * p + 1, r = l + 1, best = p;
            if (l < len && (hd[l] < hd[best] || (hd[l] === hd[best] && hn[l] < hn[best]))) best = l;
            if (r < len && (hd[r] < hd[best] || (hd[r] === hd[best] && hn[r] < hn[best]))) best = r;
            if (best === p) break;
            var td2 = hd[best]; hd[best] = hd[p]; hd[p] = td2;
            var tn2 = hn[best]; hn[best] = hn[p]; hn[p] = tn2;
            p = best;
          }
        }
        return { d: d, node: node };
      }

      push(0, S);
      while (hd.length) {
        var top = pop();
        if (top.d !== dist[top.node]) continue;
        var u = top.node, eds = adj[u];
        for (var ei = 0; ei < eds.length; ei++) {
          var eidx = eds[ei];
          if (eCap[eidx] <= 0) continue;
          var v = eTo[eidx];
          var nd = top.d + eCost[eidx] + pot[u] - pot[v];
          if (nd < dist[v]) {
            dist[v] = nd; prevV[v] = u; prevE[v] = eidx; push(nd, v);
          }
        }
      }
      if (dist[T] === Infinity) break;
      for (var v2 = 0; v2 < N; v2++) if (dist[v2] !== Infinity) pot[v2] += dist[v2];
      total += pot[T]; // S 势为 0，pot[T] 即该增广路实际费用
      var cur = T;
      while (cur !== S) {
        var pe = prevE[cur];
        eCap[pe] -= 1; eCap[eRev[pe]] += 1;
        cur = prevV[cur];
      }
      flow++;
    }
    return { count: flow, total: total };
  }

  /* 廉价下界：每个有边的设计点取其最小边距离之和（O(E)）。
   * 任何匹配（每条边对应不同设计点）的总残差都不会低于该和，故可用于在跑
   * 昂贵最小费用流前淘汰“理论最优都打不过当前残差”的候选。
   */
  function lowerBoundResidual(nD, edges) {
    var minRow = new Array(nD).fill(-1);
    for (var e = 0; e < edges.length; e++) {
      var d = edges[e].d, i = edges[e].i;
      if (minRow[i] < 0 || d < minRow[i]) minRow[i] = d;
    }
    var sum = 0;
    for (var i = 0; i < nD; i++) if (minRow[i] >= 0) sum += minRow[i];
    return sum;
  }

  /* 逐行最小边无冲突判定（O(E)）：每个有边的设计点取其距离最小的实测点
   * （并列时取较小 j），若这些实测点互不重复，则“逐点取最近边”本身构成一个
   * 合法匹配，其总残差恰为理论下界 lowerBoundResidual；若其对数还达到子图基数
   * 上界 min(有边设计点数, 有边实测点数)，则它同时是最大基数匹配，即全局最优，
   * 可跳过 HK 与最小费用流。发生冲突则返回 null 回落。
   */
  function rowMinConflictFree(nD, edges) {
    var minJ = new Array(nD).fill(-1);
    var minD = new Array(nD).fill(Infinity);
    var activeM = Object.create(null);
    for (var e = 0; e < edges.length; e++) {
      var i = edges[e].i;
      activeM[edges[e].j] = true;
      if (edges[e].d < minD[i] - 1e-12 ||
          (Math.abs(edges[e].d - minD[i]) <= 1e-12 && edges[e].j < minJ[i])) {
        minD[i] = edges[e].d; minJ[i] = edges[e].j;
      }
    }
    var taken = Object.create(null);
    var count = 0, total = 0, activeD = 0, distinctM = 0;
    for (var k in activeM) distinctM++;
    for (var i2 = 0; i2 < nD; i2++) {
      if (minJ[i2] < 0) continue;
      activeD++;
      var key = minJ[i2];
      if (taken[key]) return { conflict: true, activeD: activeD, distinctM: distinctM };
      taken[key] = true;
      count++; total += minD[i2];
    }
    return { conflict: false, count: count, total: total, activeD: activeD, distinctM: distinctM };
  }

  /* 快速综合评分：边 -> { count, total }。
   * needBeat 为当前已知最优匹配数：先用 HK 求基数，打不过即廉价返回（total=null）；
   * 首个候选（needBeat<0）直接跑精确费用流。残差下界可廉价淘汰打不平当前残差者。
   */
  function scoreEdges(nD, nM, edges, needBeat, bestTotal) {
    if (edges.length === 0) return { count: 0, total: null };
    // 边数是匹配数的上界，先于其他计算廉价剪枝
    if (needBeat >= 0 && edges.length < needBeat) return { count: -1, total: null };

    // O(E) 快速路径：逐点最近边互不冲突且达到子图基数上界 -> 即最大基数 + 最小残差
    var cf = rowMinConflictFree(nD, edges);
    if (!cf.conflict) {
      var upperBound = Math.min(cf.activeD, cf.distinctM);
      if (cf.count === upperBound) {
        if (needBeat >= 0 && cf.count < needBeat) return { count: cf.count, total: null };
        if (needBeat >= 0 && cf.count === needBeat && bestTotal != null &&
            cf.total > bestTotal + 1e-9) {
          return { count: cf.count, total: null };
        }
        return { count: cf.count, total: cf.total };
      }
    }

    var cardinality = hopcroftKarp(nD, nM, edges);
    if (needBeat >= 0 && cardinality < needBeat) return { count: cardinality, total: null };
    // 基数打平：若残差理论下界都打不过当前最优，跳过精确费用流
    if (needBeat >= 0 && cardinality === needBeat && bestTotal != null) {
      if (lowerBoundResidual(nD, edges) > bestTotal + 1e-9) {
        return { count: cardinality, total: null };
      }
    }
    var mc = minCostMatch(nD, nM, edges);
    return { count: mc.count, total: mc.total };
  }

  /* 小角度刚体估算：角度 × 平移联合搜索 */
  function estimateRigid(result, design, measured, nD, nM,
                         maxOffsetX, maxOffsetY, maxRadius, maxAngle, angleStep, center) {
    // 1. 枚举角度 [-maxAngle, maxAngle]，按步长取点（含 0 与两端），1e-9 度量化去重
    var angles = [0];
    var seenAng = Object.create(null);
    seenAng['0'] = true;
    var steps = Math.floor(maxAngle / angleStep + 1e-9);
    for (var s = 1; s <= steps; s++) {
      var a = round6deg(s * angleStep);
      if (a > maxAngle + 1e-9) break;
      var ka = String(a);
      if (!seenAng[ka]) { seenAng[ka] = true; angles.push(a); angles.push(-a); }
    }
    angles.sort(function (x, y) { return x - y; });
    result.angleCount = angles.length;

    if (angles.length > MAX_RIGID_ANGLE_STEPS) {
      result.errors.push({
        line: null,
        message: '按步长 ' + round4(angleStep) + '° 在 ±' + round4(maxAngle) +
          '° 内共需枚举 ' + angles.length + ' 个角度，超过 ' + MAX_RIGID_ANGLE_STEPS +
          ' 个上限：请加大角度步长或缩小最大旋转角后重试。'
      });
      return result;
    }

    // 每角度都要建一次 nD×nM 坐标差矩阵：总预算 = 角度数 × nD × nM
    var pairBudget = angles.length * nD * nM;
    if (pairBudget > MAX_RIGID_PAIR_BUDGET) {
      result.errors.push({
        line: null,
        message: '角度数 × 设计点 × 实测点 = ' + angles.length + '×' + nD + '×' + nM +
          '，超过 ' + MAX_RIGID_PAIR_BUDGET + ' 的计算预算：请加大角度步长或减少点数后重试。'
      });
      return result;
    }

    // 2. 逐角度：旋转与全对距离每角度只预算一次，再枚举限幅内候选平移并筛选；
    //    角度 × 平移候选数有上限保护
    var best = null;
    var evaluated = 0;
    var totalCandidates = 0;

    for (var ai = 0; ai < angles.length; ai++) {
      var angle = angles[ai];
      var matrix = buildPairwiseMatrix(design, measured, center, angle, maxRadius);

      // 候选平移 = 设计 i − 旋转后实测 j（直接取预算分量），两轴限幅、1e-6 mm 去重
      var seen = Object.create(null);
      var offsets = [];
      for (var i = 0; i < nD; i++) {
        for (var j = 0; j < nM; j++) {
          var dx = round6(matrix.bx[i][j]);
          var dy = round6(matrix.by[i][j]);
          if (Math.abs(dx) > maxOffsetX + 1e-9 || Math.abs(dy) > maxOffsetY + 1e-9) continue;
          var key = dx + ',' + dy;
          if (!seen[key]) { seen[key] = true; offsets.push({ dx: dx, dy: dy }); }
        }
      }
      totalCandidates += offsets.length;
      evaluated += offsets.length;
      if (evaluated > MAX_RIGID_EVALUATIONS) {
        result.candidateCount = totalCandidates;
        result.errors.push({
          line: null,
          message: '角度 × 平移候选评估数超过 ' + MAX_RIGID_EVALUATIONS +
            ' 个上限（当前已达 ' + evaluated + '）：请加大角度步长、收紧最大校准量 / 关联半径，或减少点数后重试。'
        });
        return result;
      }

      // 3. 每个（角度, 平移）复用一对一匹配，按五级优先级决胜
      for (var k = 0; k < offsets.length; k++) {
        var off = offsets[k];
        var edges = edgesFromMatrix(matrix, design, nD, nM, maxRadius, off.dx, off.dy);
        // 剥叶/HK 先廉价淘汰匹配数不如当前最优的候选；打平时才算精确最小残差
        var needBeat = best ? best.count : -1;
        var score = scoreEdges(nD, nM, edges, needBeat, best ? best.total : null);
        var matchCount = score.count;
        if (score.total === null) continue; // 基数/残差下界已确定劣于当前最优
        var total = score.total;
        var l1 = Math.abs(off.dx) + Math.abs(off.dy);
        var absA = Math.abs(angle);

        if (best === null ||
            matchCount > best.count ||
            (matchCount === best.count && total < best.total - 1e-9) ||
            (matchCount === best.count && Math.abs(total - best.total) <= 1e-9 &&
              (absA < best.absAngle - 1e-12 ||
               (Math.abs(absA - best.absAngle) <= 1e-12 &&
                 (l1 < best.l1 - 1e-12 ||
                  (Math.abs(l1 - best.l1) <= 1e-12 &&
                   (off.dx < best.dx - 1e-12 ||
                    (Math.abs(off.dx - best.dx) <= 1e-12 &&
                     (off.dy < best.dy - 1e-12 ||
                      (Math.abs(off.dy - best.dy) <= 1e-12 && angle < best.angle - 1e-12)))))))))) {
          best = {
            angle: angle, dx: off.dx, dy: off.dy,
            count: matchCount, total: total, l1: l1, absAngle: absA
          };
        }
      }
    }

    result.candidateCount = totalCandidates;
    if (totalCandidates === 0 || best === null) {
      result.errors.push({
        line: null,
        message: '在 ±' + round4(maxAngle) + '°（步长 ' + round4(angleStep) + '°）、X ≤ ' +
          round4(maxOffsetX) + ' mm、Y ≤ ' + round4(maxOffsetY) +
          ' mm 的联合搜索范围内没有任何可评估候选：请放大最大旋转角 / 最大校准量，或检查实测 CSV 与关联半径。'
      });
      return result;
    }
    return finalizeBest(result, best);
  }

  // 角度也按 1e-6 度量化，避免浮点尾差造成伪重复角度
  function round6deg(n) { return Math.round(n * 1000000) / 1000000; }

  /* 对指定（角度, 平移）复用质检的同一一对一匹配 */
  function matchFor(design, measured, maxRadius, center, angle, dx, dy) {
    var edges = buildRadiusCandidates(design, measured, maxRadius, dx, dy, center, angle);
    return solveMatching(design.length, measured.length, edges);
  }

  // 直接由配对双方坐标重算总残差，与候选边/质检匹配所用表达式一致
  function matchedResidual(design, measured, center, angle, dx, dy, matched) {
    var total = 0;
    for (var p = 0; p < matched.length; p++) {
      var pm = matched[p];
      var t = transformPoint(measured[pm.j].x, measured[pm.j].y, center, angle, dx, dy);
      total += hyp(design[pm.i].x, design[pm.i].y, t.x, t.y);
    }
    return total;
  }

  function finalizeBest(result, best) {
    result.ok = true;
    result.offsetX = round4(best.dx);
    result.offsetY = round4(best.dy);
    result.rotation = round4(best.angle);
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

  function buildQcSvg(design, plateWidth, plateHeight, pairs, missing, extra, params, center) {
    var centerX = center && isFinite(center.cx) ? center.cx : 0;
    var centerY = center && isFinite(center.cy) ? center.cy : 0;
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
      'viewBox="' + minX + ' ' + minY + ' ' + W + ' ' + H + '" data-unit="mm">');
    out.push('  <desc>压印质检叠加图：绿色=合格，橙色=偏移超差，红色=缺失，紫色=多余；' +
      '圆形为设计点，菱形为经刚体校准（旋转 ' + params.rotation + '°，中心 ' +
      round3(centerX) + ',' + round3(centerY) + '；再叠加平移）后的实测点，细线为配对连线。</desc>');

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
        '" y2="' + p.correctedY + '" stroke="' + col + '" stroke-width="0.12" opacity="0.65"' +
        ' data-design-index="' + p.designIndex + '" data-csv-row="' + p.csvRow +
        '" data-rotation="' + params.rotation + '"/>');
    });

    // 配对：设计点（圆）+ 实测点（菱形）
    pairs.forEach(function (p) {
      var dp = design[p.designIndex - 1] || {};
      var r = dp.r != null ? dp.r : defaultR;
      var col = p.verdict === VERDICT.PASS ? COLORS.pass : COLORS.offset;
      var s = Math.max(0.5, r * 1.5); // 菱形半边长
      out.push('  <circle cx="' + p.designX + '" cy="' + p.designY + '" r="' + round3(r) +
        '" fill="#ffffff" stroke="' + col + '" stroke-width="0.22" data-design-index="' +
        p.designIndex + '" data-csv-row="' + p.csvRow +
        '" data-verdict="' + p.verdict + '" data-rotation="' + params.rotation + '"/>');
      out.push('  <rect x="' + round3(p.correctedX - s) + '" y="' + round3(p.correctedY - s) +
        '" width="' + round3(2 * s) + '" height="' + round3(2 * s) +
        '" transform="rotate(45 ' + p.correctedX + ' ' + p.correctedY + ')" fill="' + col +
        '" opacity="0.85" data-design-index="' + p.designIndex + '" data-csv-row="' +
        p.csvRow + '" data-verdict="' + p.verdict + '" data-measured-x="' + p.measuredX +
        '" data-measured-y="' + p.measuredY + '" data-rotation="' + params.rotation +
        '" data-center-x="' + round3(centerX) + '" data-center-y="' + round3(centerY) + '"/>');
    });

    // 缺失：只有红色设计圆 + 叉
    missing.forEach(function (m) {
      var dp = design[m.designIndex - 1] || {};
      var r = dp.r != null ? dp.r : defaultR;
      out.push('  <circle cx="' + m.x + '" cy="' + m.y + '" r="' + round3(r) +
        '" fill="#ffffff" stroke="' + COLORS.missing + '" stroke-width="0.22" data-design-index="' +
        m.designIndex + '" data-verdict="missing" data-rotation="' + params.rotation + '"/>');
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
        ' data-measured-x="' + g.measuredX + '" data-measured-y="' + g.measuredY +
        '" data-rotation="' + params.rotation + '" data-center-x="' + round3(centerX) +
        '" data-center-y="' + round3(centerY) + '"/>');
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

  function buildReportCsv(pairs, missing, extra, params, stats, center) {
    var centerX = center && isFinite(center.cx) ? round4(center.cx) : '';
    var centerY = center && isFinite(center.cy) ? round4(center.cy) : '';
    var head = [
      'design_index', 'design_x_mm', 'design_y_mm',
      'csv_row', 'measured_x_mm', 'measured_y_mm',
      'corrected_x_mm', 'corrected_y_mm', 'distance_mm', 'conclusion',
      'rotation_deg'
    ];
    var rows = [head.map(csvCell).join(',')];

    function pushRow(vals) { rows.push(vals.map(csvCell).join(',')); }

    pairs.forEach(function (p) {
      pushRow([
        p.designIndex, p.designX, p.designY,
        p.csvRow, p.measuredX, p.measuredY,
        p.correctedX, p.correctedY, p.distance,
        VERDICT_LABEL[p.verdict], params.rotation
      ]);
    });
    missing.forEach(function (m) {
      pushRow([m.designIndex, m.x, m.y, '', '', '', '', '', '', VERDICT_LABEL.missing, params.rotation]);
    });
    extra.forEach(function (g) {
      pushRow(['', '', '', g.csvRow, g.measuredX, g.measuredY, g.x, g.y, '', VERDICT_LABEL.extra, params.rotation]);
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
    rows.push(['# params', 'offset_x_mm', 'offset_y_mm', 'rotation_deg', 'rotation_center_x_mm', 'rotation_center_y_mm', 'tolerance_mm', 'max_radius_mm'].map(csvCell).join(','));
    rows.push(['', params.offsetX, params.offsetY, params.rotation, centerX, centerY, params.tolerance, params.maxRadius].map(csvCell).join(','));

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
