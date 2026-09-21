/*
 * 盲文标签排版台 前端逻辑
 * 两种模式：
 *   - 排版：输入变化 -> 防抖调用 POST /api/layout -> 渲染 SVG 预览 / 错误 -> 下载 SVG/JSON
 *   - 压印质检：以最近一次成功排版的设计点为基准，粘贴实测 CSV 并设置偏移/公差/半径，
 *     调用 POST /api/qc（浏览器端也可直接用 window.QC 同构计算），渲染四类叠加 SVG 与报告下载
 */
(function () {
  'use strict';

  /* ================= 模式切换 ================= */

  var tabLayout = document.getElementById('tabLayout');
  var tabQc = document.getElementById('tabQc');
  var viewLayout = document.getElementById('viewLayout');
  var viewQc = document.getElementById('viewQc');

  function setMode(mode) {
    var isQc = mode === 'qc';
    tabLayout.classList.toggle('active', !isQc);
    tabQc.classList.toggle('active', isQc);
    tabLayout.setAttribute('aria-selected', String(!isQc));
    tabQc.setAttribute('aria-selected', String(isQc));
    viewLayout.hidden = isQc;
    viewQc.hidden = !isQc;
    if (isQc) refreshBaselineBox();
  }
  tabLayout.addEventListener('click', function () { setMode('layout'); });
  tabQc.addEventListener('click', function () { setMode('qc'); });

  /* ================= 排版模式 ================= */

  var fields = ['text', 'plateWidth', 'plateHeight', 'dotSpacing', 'lineSpacing', 'margin', 'cellGap', 'dotDiameter'];
  var els = {};
  fields.forEach(function (id) { els[id] = document.getElementById(id); });

  var errorsBox = document.getElementById('errors');
  var statsBox = document.getElementById('stats');
  var preview = document.getElementById('preview');
  var brailleLine = document.getElementById('brailleLine');
  var btnSvg = document.getElementById('downloadSvg');
  var btnJson = document.getElementById('downloadJson');

  var lastResult = null;     // 最近一次成功的排版结果（用于下载）
  var lastBaseline = null;   // 最近一次成功排版的设计点基准（质检模式用，失败时不被清空）
  var debounceTimer = null;

  function collectParams() {
    var p = { text: els.text.value };
    ['plateWidth', 'plateHeight', 'dotSpacing', 'lineSpacing', 'margin', 'cellGap', 'dotDiameter'].forEach(function (id) {
      var v = els[id].value.trim();
      if (v !== '') p[id] = Number(v);
    });
    return p;
  }

  function renderErrors(errors) {
    errorsBox.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      ul.appendChild(li);
    });
    errorsBox.appendChild(ul);
    errorsBox.hidden = false;
  }

  function renderStats(r) {
    var p = r.params;
    var s = r.stats;
    statsBox.innerHTML =
      '每行最多 <b>' + r.cellsPerLine + '</b> 个盲文单元，最多 <b>' + r.maxLines + '</b> 行；' +
      '本次 <b>' + s.totalLines + '</b> 行 / <b>' + s.totalCells + '</b> 个单元 / <b>' + s.totalDots + '</b> 个凸点<br>' +
      '占用幅面 ' + s.usedWidth + ' × ' + s.usedHeight + ' mm（板材 ' + p.plateWidth + ' × ' + p.plateHeight + ' mm，' +
      '字距 ' + p.cellGap + ' mm，凸点直径 ' + p.dotDiameter + ' mm）';
    statsBox.hidden = false;
  }

  function fmtTime(d) {
    function z(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) +
      ' ' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
  }

  function update() {
    var params = collectParams();
    fetch('/api/layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params)
    })
      .then(function (res) { return res.json(); })
      .then(function (r) {
        if (r.ok) {
          lastResult = r;
          // 质检基准：记录最近一次成功排版（含时间戳与完整参数）
          lastBaseline = {
            time: fmtTime(new Date()),
            text: r.params.text,
            params: r.params,
            dots: r.dots
          };
          errorsBox.hidden = true;
          // 内联预览时去掉 XML 声明，避免被 HTML 解析器当作冗余节点
          preview.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
          brailleLine.textContent = r.brailleText.replace(/\n/g, ' / ');
          renderStats(r);
          btnSvg.disabled = false;
          btnJson.disabled = false;
        } else {
          lastResult = null;
          statsBox.hidden = true;
          brailleLine.textContent = '';
          preview.innerHTML = '<p class="placeholder">排版失败：请根据左侧原因调整参数</p>';
          renderErrors(r.errors || [{ message: '未知错误' }]);
          btnSvg.disabled = true;
          btnJson.disabled = true;
        }
      })
      .catch(function () {
        lastResult = null;
        statsBox.hidden = true;
        preview.innerHTML = '<p class="placeholder">无法连接服务器</p>';
        renderErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
        btnSvg.disabled = true;
        btnJson.disabled = true;
      });
  }

  function scheduleUpdate() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(update, 250);
  }

  fields.forEach(function (id) {
    els[id].addEventListener('input', scheduleUpdate);
  });

  function download(filename, mime, content) {
    var blob = new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  btnSvg.addEventListener('click', function () {
    if (lastResult) download('braille-label.svg', 'image/svg+xml;charset=utf-8', lastResult.svg);
  });

  btnJson.addEventListener('click', function () {
    if (!lastResult) return;
    var copy = {};
    Object.keys(lastResult).forEach(function (k) {
      if (k !== 'svg') copy[k] = lastResult[k]; // JSON 下载不含 svg 字符串本体
    });
    download('braille-layout.json', 'application/json;charset=utf-8', JSON.stringify(copy, null, 2));
  });

  /* ================= 压印质检模式 ================= */

  var qcCsv = document.getElementById('qcCsv');
  var qcOffsetX = document.getElementById('qcOffsetX');
  var qcOffsetY = document.getElementById('qcOffsetY');
  var qcTolerance = document.getElementById('qcTolerance');
  var qcMaxRadius = document.getElementById('qcMaxRadius');
  var qcRun = document.getElementById('qcRun');
  var qcErrors = document.getElementById('qcErrors');
  var qcStats = document.getElementById('qcStats');
  var qcPreview = document.getElementById('qcPreview');
  var qcLegend = document.getElementById('qcLegend');
  var qcBaseline = document.getElementById('qcBaseline');
  var qcMaxOffsetX = document.getElementById('qcMaxOffsetX');
  var qcMaxOffsetY = document.getElementById('qcMaxOffsetY');
  var qcAutoCalibrate = document.getElementById('qcAutoCalibrate');
  var qcCalibMsg = document.getElementById('qcCalibMsg');
  var btnQcCsv = document.getElementById('qcDownloadCsv');
  var btnQcSvg = document.getElementById('qcDownloadSvg');

  var lastQc = null;
  var qcTimer = null;

  function refreshBaselineBox() {
    if (lastBaseline) {
      var safeText = String(lastBaseline.text).replace(/[<>&]/g, function (c) {
        return c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;';
      });
      qcBaseline.className = 'baseline ok';
      qcBaseline.innerHTML =
        '基准：最近一次成功排版「<b>' + (safeText || '（空白标签）') + '</b>」' +
        '（' + lastBaseline.dots.length + ' 个设计点，板材 ' +
        lastBaseline.params.plateWidth + ' × ' + lastBaseline.params.plateHeight + ' mm）<br>' +
        '<span class="muted">排版时间 ' + lastBaseline.time + '</span>';
    } else {
      qcBaseline.className = 'baseline warn';
      qcBaseline.innerHTML = '尚无成功排版基准：请先切换到「排版模式」完成一次成功排版。';
    }
  }

  function numVal(input) {
    var v = input.value.trim();
    return v === '' ? null : Number(v);
  }

  function renderQcErrors(errors) {
    qcErrors.innerHTML = '';
    var ul = document.createElement('ul');
    errors.forEach(function (e) {
      var li = document.createElement('li');
      li.textContent = e.message;
      if (e.line != null) li.dataset.line = e.line;
      ul.appendChild(li);
    });
    qcErrors.appendChild(ul);
    qcErrors.hidden = false;
  }

  function renderQcStats(r) {
    var s = r.stats;
    qcStats.innerHTML =
      '通过率 <b class="rate">' + s.passRatePercent + '%</b>' +
      '（合格 <b>' + s.passCount + '</b> / 设计点 ' + s.designCount + '）　' +
      '配对 <b>' + s.matchedCount + '</b>，其中偏移超差 <b>' + s.offsetCount + '</b>；' +
      '缺失 <b>' + s.missingCount + '</b>，多余 <b>' + s.extraCount + '</b><br>' +
      '最大偏差 <b>' + (s.maxDeviation == null ? '—' : s.maxDeviation) + '</b> mm；' +
      '平均偏差 <b>' + (s.meanDeviation == null ? '—' : s.meanDeviation) + '</b> mm' +
      '（公差 ' + r.params.tolerance + ' mm，关联半径 ' + r.params.maxRadius +
      ' mm，偏移 ' + r.params.offsetX + ' / ' + r.params.offsetY + ' mm）';
    qcStats.hidden = false;
    qcLegend.hidden = false;
  }

  function handleQcResult(r) {
    if (r.ok) {
      lastQc = r;
      qcErrors.hidden = true;
      qcPreview.innerHTML = r.svg.replace(/^<\?xml[^?]*\?>\s*/, '');
      renderQcStats(r);
      btnQcCsv.disabled = false;
      btnQcSvg.disabled = false;
    } else {
      lastQc = null;
      qcStats.hidden = true;
      qcLegend.hidden = true;
      qcPreview.innerHTML = '<p class="placeholder">质检未能完成：请根据左侧错误修正后重试</p>';
      renderQcErrors(r.errors || [{ message: '未知错误' }]);
      btnQcCsv.disabled = true;
      btnQcSvg.disabled = true;
    }
  }

  function runQc() {
    if (!lastBaseline) {
      refreshBaselineBox();
      renderQcErrors([{ message: '没有成功排版的设计点基准，请先在「排版模式」完成排版。' }]);
      return;
    }
    var payload = {
      design: lastBaseline.dots,
      plateWidth: lastBaseline.params.plateWidth,
      plateHeight: lastBaseline.params.plateHeight,
      csv: qcCsv.value,
      offsetX: numVal(qcOffsetX),
      offsetY: numVal(qcOffsetY),
      tolerance: numVal(qcTolerance),
      maxRadius: numVal(qcMaxRadius)
    };
    fetch('/api/qc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(handleQcResult)
      .catch(function () {
        // 服务不可用时回退到浏览器内置同构实现
        if (window.QC) {
          try {
            handleQcResult(QC.inspect(payload));
          } catch (e) {
            renderQcErrors([{ message: '质检计算失败：' + e.message }]);
          }
        } else {
          renderQcErrors([{ message: '网络请求失败，请确认服务已启动。' }]);
        }
      });
  }

  qcRun.addEventListener('click', runQc);

  /* ---------- 自动校准：一键估算全局平移并写回偏移输入框 ---------- */

  function showCalibMsg(kind, text) {
    qcCalibMsg.className = 'calib-msg ' + kind;
    qcCalibMsg.textContent = text;
    qcCalibMsg.hidden = false;
  }

  function handleCalibResult(r) {
    if (r.ok) {
      // 写回估算值（程序化赋值，不会触发 input 事件），再立即重跑四类判定
      qcOffsetX.value = r.offsetX;
      qcOffsetY.value = r.offsetY;
      showCalibMsg(
        'ok',
        '估算全局平移：X = ' + r.offsetX + ' mm，Y = ' + r.offsetY +
        ' mm（候选 ' + r.candidateCount + ' 个，匹配 ' + r.matchedCount +
        ' 对，总残差 ' + r.totalResidual + ' mm）；偏移已写回并自动重跑质检。'
      );
      runQc();
    } else {
      // 无可用候选 / 参数非法：保留偏移输入框原值，仅给出明确提示
      var msg = (r.errors && r.errors[0] && r.errors[0].message) || '自动校准失败。';
      showCalibMsg('warn', '未能估算全局平移，偏移输入保持原值：' + msg);
    }
  }

  function runAutoCalibrate() {
    if (!lastBaseline) {
      refreshBaselineBox();
      renderQcErrors([{ message: '没有成功排版的设计点基准，请先在「排版模式」完成排版。' }]);
      return;
    }
    var payload = {
      design: lastBaseline.dots,
      csv: qcCsv.value,
      maxOffsetX: numVal(qcMaxOffsetX),
      maxOffsetY: numVal(qcMaxOffsetY),
      maxRadius: numVal(qcMaxRadius)
    };
    qcAutoCalibrate.disabled = true;
    fetch('/api/qc/calibrate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
      .then(function (res) { return res.json(); })
      .then(function (r) { handleCalibResult(r); })
      .catch(function () {
        // 服务不可用时回退到浏览器内置同构实现
        if (window.QC) {
          try {
            handleCalibResult(QC.estimateCalibration(payload));
          } catch (e) {
            showCalibMsg('warn', '自动校准计算失败：' + e.message);
          }
        } else {
          showCalibMsg('warn', '网络请求失败，请确认服务已启动；偏移输入保持原值。');
        }
      })
      .finally(function () { qcAutoCalibrate.disabled = false; });
  }

  qcAutoCalibrate.addEventListener('click', runAutoCalibrate);

  // 参数或 CSV 修改后防抖自动重跑（已有质检结果时），手动按钮始终可用；
  // 输入一旦被改动，清掉上一次自动校准的提示
  [qcCsv, qcOffsetX, qcOffsetY, qcTolerance, qcMaxRadius, qcMaxOffsetX, qcMaxOffsetY].forEach(function (el) {
    el.addEventListener('input', function () {
      if (!qcCalibMsg.hidden) qcCalibMsg.hidden = true;
      if (!lastQc) return;
      clearTimeout(qcTimer);
      qcTimer = setTimeout(runQc, 300);
    });
  });

  btnQcCsv.addEventListener('click', function () {
    if (lastQc) download('embossing-qc-report.csv', 'text/csv;charset=utf-8', lastQc.csv);
  });
  btnQcSvg.addEventListener('click', function () {
    if (lastQc) download('embossing-qc-overlay.svg', 'image/svg+xml;charset=utf-8', lastQc.svg);
  });

  /* ================= 启动 ================= */

  update(); // 首屏立即排版
})();
