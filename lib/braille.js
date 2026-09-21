/*
 * 六点一级盲文（English Braille, Grade 1）转换与排版核心模块。
 * 同时供 Node 服务端与浏览器前端使用（UMD）。
 *
 * 坐标系约定（单位均为毫米 mm）：
 *   - 原点 (0,0) 在板材左上角，x 向右，y 向下；
 *   - 一个盲文单元为 2 列 × 3 行凸点，点 1/2/3 在左列自上而下，点 4/5/6 在右列；
 *   - 点距 dotSpacing：单元内相邻点（横向与纵向）的中心距；
 *   - 字距 cellGap：相邻单元右列与下一单元左列之间的净间距；
 *   - 行距 lineSpacing：相邻两行单元顶行点的中心距（行pitch）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.Braille = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- 基础码表 ---------------- */

  // 字母：点序号数组（1~6）
  var LETTERS = {
    a: [1], b: [1, 2], c: [1, 4], d: [1, 4, 5], e: [1, 5],
    f: [1, 2, 4], g: [1, 2, 4, 5], h: [1, 2, 5], i: [2, 4], j: [2, 4, 5],
    k: [1, 3], l: [1, 2, 3], m: [1, 3, 4], n: [1, 3, 4, 5], o: [1, 3, 5],
    p: [1, 2, 3, 4], q: [1, 2, 3, 4, 5], r: [1, 2, 3, 5], s: [2, 3, 4], t: [2, 3, 4, 5],
    u: [1, 3, 6], v: [1, 2, 3, 6], w: [2, 4, 5, 6], x: [1, 3, 4, 6],
    y: [1, 3, 4, 5, 6], z: [1, 3, 5, 6]
  };

  // 数字：一级盲文中 1~0 复用 a~j 的点位，前置数字符 ⠼
  var DIGIT_TO_LETTER = {
    '1': 'a', '2': 'b', '3': 'c', '4': 'd', '5': 'e',
    '6': 'f', '7': 'g', '8': 'h', '9': 'i', '0': 'j'
  };

  var CAPITAL_SIGN = [6];          // 大写前缀 ⠠
  var NUMBER_SIGN = [3, 4, 5, 6];  // 数字前缀 ⠼

  // 常用标点（一级盲文）
  var PUNCT = {
    ',': [2], ';': [2, 3], ':': [2, 5], '.': [2, 5, 6],
    '!': [2, 3, 5], '?': [2, 3, 6], "'": [3], '-': [3, 6],
    '(': [2, 3, 5, 6], ')': [2, 3, 5, 6], '/': [3, 4],
    '&': [1, 2, 3, 4, 6], '*': [1, 6], '@': [4], '#': [3, 4, 5, 6],
    '+': [2, 3, 5], '=': [2, 3, 5, 6]
  };

  // 数字模式下遇到这些标点不中断数字段（如 3.14、1,000）
  var NUMERIC_GLUE = { '.': true, ',': true };

  /* ---------------- 工具 ---------------- */

  // 点序号数组 -> 盲文 Unicode 字符（U+2800 起，点 n 对应第 n-1 位）
  function dotsToUnicode(dots) {
    var bits = 0;
    for (var i = 0; i < dots.length; i++) bits |= (1 << (dots[i] - 1));
    return String.fromCharCode(0x2800 + bits);
  }

  function isLetter(ch) { return /^[a-z]$/i.test(ch); }
  function isDigit(ch) { return /^[0-9]$/.test(ch); }

  /* ---------------- 文本 -> 盲文单元序列 ----------------
   * 返回 { cells, errors }
   * cell: { dots:[...], char, kind, braille }
   *   kind: letter | digit | punct | caps-prefix | number-prefix | space
   */
  function textToCells(text) {
    var cells = [];
    var errors = [];
    var unsupported = {};
    var inNumber = false;

    var push = function (dots, ch, kind) {
      cells.push({ dots: dots, char: ch, kind: kind, braille: dotsToUnicode(dots) });
    };

    for (var i = 0; i < text.length; i++) {
      var ch = text[i];

      if (/\s/.test(ch)) {           // 任意空白（含换行）都视为词间空格
        push([], ' ', 'space');
        inNumber = false;
        continue;
      }

      if (isDigit(ch)) {
        if (!inNumber) {             // 连续数字段只在段首加一个数字前缀
          push(NUMBER_SIGN, '#', 'number-prefix');
          inNumber = true;
        }
        push(LETTERS[DIGIT_TO_LETTER[ch]], ch, 'digit');
        continue;
      }

      if (isLetter(ch)) {
        inNumber = false;
        if (ch === ch.toUpperCase()) {
          push(CAPITAL_SIGN, ch, 'caps-prefix'); // 每个大写字母前加大写前缀
        }
        push(LETTERS[ch.toLowerCase()], ch, 'letter');
        continue;
      }

      if (PUNCT[ch]) {
        if (!(inNumber && NUMERIC_GLUE[ch])) inNumber = false;
        push(PUNCT[ch], ch, 'punct');
        continue;
      }

      unsupported[ch] = true; // 不支持的字符：记录后跳过，由 errors 统一报告
    }

    var bad = Object.keys(unsupported);
    if (bad.length) {
      errors.push({
        type: 'unsupported-char',
        message: '字符 ' + bad.map(function (c) { return '“' + c + '”'; }).join('、') +
          ' 不在支持范围内（仅支持 A–Z、a–z、0–9 及常用标点），已从转换中忽略。'
      });
    }

    return { cells: cells, errors: errors };
  }

  /* ---------------- 参数规范化与校验 ---------------- */

  var DEFAULTS = {
    text: '',
    plateWidth: 100,   // 板材宽 mm
    plateHeight: 50,   // 板材高 mm
    dotSpacing: 2.5,   // 点距 mm
    lineSpacing: 10,   // 行距 mm
    margin: 5,         // 四周边距 mm
    cellGap: null,     // 字距 mm，默认 1.4 × 点距（标准 2.5mm 点距 → 6mm 单元pitch）
    dotDiameter: null, // 凸点直径 mm，默认 0.6 × 点距（标准 ≈1.5mm）
    maxTextLength: 500
  };

  function num(v) {
    var n = typeof v === 'string' ? parseFloat(v) : v;
    return (typeof n === 'number' && isFinite(n)) ? n : NaN;
  }

  function round3(n) { return Math.round(n * 1000) / 1000; }

  function normalizeParams(input) {
    input = input || {};
    var errors = [];

    var p = {
      text: typeof input.text === 'string' ? input.text : '',
      plateWidth: num(input.plateWidth != null ? input.plateWidth : DEFAULTS.plateWidth),
      plateHeight: num(input.plateHeight != null ? input.plateHeight : DEFAULTS.plateHeight),
      dotSpacing: num(input.dotSpacing != null ? input.dotSpacing : DEFAULTS.dotSpacing),
      lineSpacing: num(input.lineSpacing != null ? input.lineSpacing : DEFAULTS.lineSpacing),
      margin: num(input.margin != null ? input.margin : DEFAULTS.margin)
    };

    if (p.text.length > DEFAULTS.maxTextLength) {
      errors.push({ type: 'text-too-long', message: '标签文本超过 ' + DEFAULTS.maxTextLength + ' 字符上限。' });
    }
    if (!(p.plateWidth > 0)) errors.push({ type: 'param', message: '板材宽度必须为正数。' });
    if (!(p.plateHeight > 0)) errors.push({ type: 'param', message: '板材高度必须为正数。' });
    if (!(p.dotSpacing > 0)) errors.push({ type: 'param', message: '点距必须为正数。' });
    if (!(p.lineSpacing > 0)) errors.push({ type: 'param', message: '行距必须为正数。' });
    if (!(p.margin >= 0)) errors.push({ type: 'param', message: '边距不能为负数。' });
    if (errors.length) return { params: null, errors: errors };

    // 派生参数
    p.cellGap = (input.cellGap != null && input.cellGap !== '') ? num(input.cellGap) : round3(1.4 * p.dotSpacing);
    p.dotDiameter = (input.dotDiameter != null && input.dotDiameter !== '') ? num(input.dotDiameter) : round3(0.6 * p.dotSpacing);
    if (!(p.cellGap >= 0)) errors.push({ type: 'param', message: '字距不能为负数。' });
    if (!(p.dotDiameter > 0)) errors.push({ type: 'param', message: '凸点直径必须为正数。' });

    // 几何约束
    var cellHeight = 2 * p.dotSpacing; // 单元纵向占 3 行点：0, d, 2d
    if (p.lineSpacing < cellHeight) {
      errors.push({
        type: 'param',
        message: '行距（' + p.lineSpacing + 'mm）不能小于单元高度 2×点距（' + round3(cellHeight) + 'mm），否则相邻行凸点重叠。'
      });
    }
    if (2 * p.margin >= p.plateWidth) {
      errors.push({ type: 'param', message: '左右边距之和（' + round3(2 * p.margin) + 'mm）必须小于板材宽度（' + p.plateWidth + 'mm）。' });
    }
    if (2 * p.margin >= p.plateHeight) {
      errors.push({ type: 'param', message: '上下边距之和（' + round3(2 * p.margin) + 'mm）必须小于板材高度（' + p.plateHeight + 'mm）。' });
    }

    p.cellPitch = round3(p.dotSpacing + p.cellGap); // 相邻单元左列间距
    p.cellHeight = round3(cellHeight);
    return { params: p, errors: errors };
  }

  /* ---------------- 排版（整词换行） ---------------- */

  function layout(input) {
    var norm = normalizeParams(input);
    var errors = norm.errors.slice();
    var p = norm.params;

    var base = {
      ok: false,
      errors: errors,
      params: p,
      cellsPerLine: 0,
      maxLines: 0,
      lines: [],
      dots: [],
      brailleText: '',
      stats: null,
      svg: null
    };
    if (!p || errors.length) return base;

    // 1. 文本 -> 单元
    var conv = textToCells(p.text);
    errors.push.apply(errors, conv.errors);
    var cells = conv.cells;

    // 2. 容量：n 个单元占宽 (n-1)*cellPitch + dotSpacing
    var usableW = p.plateWidth - 2 * p.margin;
    var usableH = p.plateHeight - 2 * p.margin;
    var cellsPerLine = Math.floor((usableW - p.dotSpacing) / p.cellPitch) + 1;
    var maxLines = Math.floor((usableH - p.cellHeight) / p.lineSpacing) + 1;
    base.cellsPerLine = Math.max(0, cellsPerLine);
    base.maxLines = Math.max(0, maxLines);

    if (cellsPerLine < 1) {
      errors.push({
        type: 'no-fit',
        message: '板材有效宽度 ' + round3(usableW) + 'mm 连 1 个盲文单元（宽 ' + p.dotSpacing + 'mm）都容纳不下，请加宽板材、减小边距或点距。'
      });
    }
    if (maxLines < 1) {
      errors.push({
        type: 'no-fit',
        message: '板材有效高度 ' + round3(usableH) + 'mm 连 1 行盲文（高 ' + p.cellHeight + 'mm）都容纳不下，请加高板材或减小边距。'
      });
    }
    if (errors.length) return base;

    // 3. 按空格切词（词 = 前缀+字母/数字的完整单元序列）
    var words = [];
    var cur = [];
    cells.forEach(function (c) {
      if (c.kind === 'space') {
        if (cur.length) { words.push(cur); cur = []; }
      } else {
        cur.push(c);
      }
    });
    if (cur.length) words.push(cur);

    // 4. 整词换行：任何单词超长或总行数超容都报错，绝不裁切
    var lines = [];
    var lineCells = []; // 当前行单元（含词间空格占位）
    var usedCells = 0;

    var pushLine = function () {
      lines.push(lineCells);
      lineCells = [];
      usedCells = 0;
    };

    for (var wi = 0; wi < words.length; wi++) {
      var word = words[wi];
      // 报错信息中的原词：只取字母/数字/标点本体，不含前缀单元
      var wordText = word.filter(function (c) {
        return c.kind !== 'caps-prefix' && c.kind !== 'number-prefix';
      }).map(function (c) { return c.char; }).join('');
      if (word.length > cellsPerLine) {
        errors.push({
          type: 'word-too-long',
          message: '单词 “' + wordText + '” 转换后占 ' + word.length + ' 个盲文单元（含大写/数字前缀），超过每行最多 ' +
            cellsPerLine + ' 个单元；请加宽板材、减小点距/字距，或拆分该词。'
        });
        continue;
      }
      var need = usedCells === 0 ? word.length : usedCells + 1 + word.length;
      if (need > cellsPerLine) {
        pushLine(); // 当前行放不下则整词移到下一行，继续排版以统计真实所需行数
        lineCells = word.slice();
        usedCells = word.length;
      } else {
        if (usedCells > 0) {
          lineCells.push({ dots: [], char: ' ', kind: 'space', braille: dotsToUnicode([]) });
          usedCells += 1;
        }
        lineCells = lineCells.concat(word);
        usedCells += word.length;
      }
    }
    if (lineCells.length) pushLine();

    if (lines.length > maxLines) {
      errors.push({
        type: 'too-many-lines',
        message: '整词换行后共需 ' + lines.length + ' 行，板材有效高度仅容纳 ' + maxLines +
          ' 行；请加高板材、减小行距/边距，或精简文字。'
      });
    }
    if (errors.length) return base; // 放不下：只报原因，不输出任何被裁切的结果

    // 5. 计算每个凸点的毫米坐标
    var dots = [];
    var laidLines = lines.map(function (line, li) {
      var y0 = p.margin + li * p.lineSpacing;
      return line.map(function (cell, ci) {
        var x0 = p.margin + ci * p.cellPitch;
        var placed = { char: cell.char, kind: cell.kind, braille: cell.braille, dots: cell.dots, x: round3(x0), y: round3(y0) };
        cell.dots.forEach(function (d) {
          var col = d <= 3 ? 0 : 1;      // 点1-3 左列，点4-6 右列
          var row = (d - 1) % 3;         // 行 0/1/2
          dots.push({
            x: round3(x0 + col * p.dotSpacing),
            y: round3(y0 + row * p.dotSpacing),
            r: round3(p.dotDiameter / 2),
            line: li + 1,
            cell: ci + 1,
            dot: d
          });
        });
        return placed;
      });
    });

    var brailleText = laidLines.map(function (line) {
      return line.map(function (c) { return c.braille; }).join('');
    }).join('\n');

    var usedWidth = lines.length && lines[0].length
      ? Math.max.apply(null, lines.map(function (l) { return (l.length - 1) * p.cellPitch + p.dotSpacing; }))
      : 0;
    var usedHeight = lines.length ? (lines.length - 1) * p.lineSpacing + p.cellHeight : 0;

    base.ok = true;
    base.lines = laidLines;
    base.dots = dots;
    base.brailleText = brailleText;
    base.stats = {
      totalCells: cells.filter(function (c) { return c.kind !== 'space'; }).length,
      totalDots: dots.length,
      totalLines: lines.length,
      usedWidth: round3(usedWidth),
      usedHeight: round3(usedHeight)
    };
    base.svg = buildSvg(p, dots);
    return base;
  }

  /* ---------------- SVG 生成（单位 mm） ---------------- */

  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function buildSvg(p, dots) {
    var W = p.plateWidth, H = p.plateHeight;
    var out = [];
    out.push('<?xml version="1.0" encoding="UTF-8"?>');
    out.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + 'mm" height="' + H + 'mm" ' +
      'viewBox="0 0 ' + W + ' ' + H + '" data-unit="mm">');
    out.push('  <!-- 板材 ' + W + 'mm × ' + H + 'mm；点距 ' + p.dotSpacing + 'mm，行距 ' + p.lineSpacing +
      'mm，边距 ' + p.margin + 'mm；坐标单位均为 mm -->');
    out.push('  <rect id="plate" x="0" y="0" width="' + W + '" height="' + H + '" fill="#ffffff" stroke="#333333" stroke-width="0.3"/>');
    out.push('  <rect id="margin-guide" x="' + p.margin + '" y="' + p.margin + '" width="' + round3(W - 2 * p.margin) +
      '" height="' + round3(H - 2 * p.margin) + '" fill="none" stroke="#bbbbbb" stroke-width="0.15" stroke-dasharray="1 1"/>');
    out.push('  <g id="raised-dots" fill="#111111">');
    dots.forEach(function (d) {
      out.push('    <circle cx="' + d.x + '" cy="' + d.y + '" r="' + d.r + '" data-line="' + d.line +
        '" data-cell="' + d.cell + '" data-dot="' + d.dot + '"/>');
    });
    out.push('  </g>');
    out.push('</svg>');
    return out.join('\n');
  }

  return {
    LETTERS: LETTERS,
    NUMBER_SIGN: NUMBER_SIGN,
    CAPITAL_SIGN: CAPITAL_SIGN,
    DEFAULTS: DEFAULTS,
    dotsToUnicode: dotsToUnicode,
    textToCells: textToCells,
    normalizeParams: normalizeParams,
    layout: layout
  };
});
