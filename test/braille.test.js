'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Braille = require('../lib/braille');

/* ---------- 一级盲文转换 ---------- */

test('小写字母直接转换，无前缀', () => {
  const { cells, errors } = Braille.textToCells('abc');
  assert.equal(errors.length, 0);
  assert.deepEqual(cells.map(c => c.dots), [[1], [1, 2], [1, 4]]);
  assert.deepEqual(cells.map(c => c.kind), ['letter', 'letter', 'letter']);
});

test('每个大写字母前加大写前缀（点6）', () => {
  const { cells } = Braille.textToCells('Ab');
  assert.equal(cells.length, 3);
  assert.deepEqual(cells[0].dots, [6]);
  assert.equal(cells[0].kind, 'caps-prefix');
  assert.deepEqual(cells[1].dots, [1]);   // a
  assert.deepEqual(cells[2].dots, [1, 2]); // b
});

test('连续数字段只加一个数字前缀，字母结束数字段', () => {
  const { cells } = Braille.textToCells('123a45');
  const kinds = cells.map(c => c.kind);
  assert.deepEqual(kinds, [
    'number-prefix', 'digit', 'digit', 'digit',
    'letter',
    'number-prefix', 'digit', 'digit'
  ]);
  // 数字 1,2,3 -> a,b,c 点位
  assert.deepEqual(cells[1].dots, [1]);
  assert.deepEqual(cells[2].dots, [1, 2]);
  assert.deepEqual(cells[3].dots, [1, 4]);
});

test('数字段中的小数点/逗号不中断数字模式', () => {
  const { cells } = Braille.textToCells('3.14');
  const kinds = cells.map(c => c.kind);
  assert.deepEqual(kinds, ['number-prefix', 'digit', 'punct', 'digit', 'digit']);
});

test('不支持的字符被报告并忽略', () => {
  const { cells, errors } = Braille.textToCells('a中b');
  assert.equal(errors.length, 1);
  assert.equal(errors[0].type, 'unsupported-char');
  assert.equal(cells.filter(c => c.kind === 'letter').length, 2);
});

test('盲文 Unicode 码位正确', () => {
  assert.equal(Braille.dotsToUnicode([1]), '⠁');
  assert.equal(Braille.dotsToUnicode([3, 4, 5, 6]), '⠼');
  assert.equal(Braille.dotsToUnicode([6]), '⠠');
});

/* ---------- 排版与换行 ---------- */

const FIT_ALL = { plateWidth: 100, plateHeight: 50, dotSpacing: 2.5, lineSpacing: 10, margin: 5 };

test('正常排版：容量、坐标与 SVG', () => {
  const r = Braille.layout({ text: 'ab', ...FIT_ALL });
  assert.equal(r.ok, true);
  // 有效宽 90mm：cellsPerLine = floor((90-2.5)/6)+1 = 15；有效高 40mm：maxLines = floor((40-5)/10)+1 = 4
  assert.equal(r.cellsPerLine, 15);
  assert.equal(r.maxLines, 4);
  assert.equal(r.stats.totalLines, 1);
  // a 的点1 在 (5,5)；b 的点1 在 (5+6,5)，点2 在 (11,7.5)
  const d = r.dots;
  assert.deepEqual([d[0].x, d[0].y], [5, 5]);
  const bDot2 = d.find(x => x.cell === 2 && x.dot === 2);
  assert.deepEqual([bDot2.x, bDot2.y], [11, 7.5]);
  assert.match(r.svg, /^<\?xml/);
  assert.match(r.svg, /width="100mm"/);
  assert.match(r.svg, /<circle /);
});

test('整词换行：词不可拆分，空格占一个单元', () => {
  // 每行 4 个单元：ab(2) + 空格(1) + cd(2) = 5 > 4，故 cd 移到第二行
  const r = Braille.layout({ text: 'ab cd', plateWidth: 30.9, plateHeight: 50, dotSpacing: 2.5, lineSpacing: 10, margin: 5 });
  // cellsPerLine = floor((20.9-2.5)/6)+1 = 4
  assert.equal(r.cellsPerLine, 4);
  assert.equal(r.ok, true);
  assert.equal(r.stats.totalLines, 2);
  assert.equal(r.lines[0].map(c => c.char).join(''), 'ab');
  assert.equal(r.lines[1].map(c => c.char).join(''), 'cd');
});

test('单词超长：报出原因且不输出排版结果（不裁切）', () => {
  const r = Braille.layout({ text: 'abcdefgh', plateWidth: 30.9, plateHeight: 50, dotSpacing: 2.5, lineSpacing: 10, margin: 5 });
  assert.equal(r.ok, false);
  assert.equal(r.svg, null);
  assert.equal(r.dots.length, 0);
  const err = r.errors.find(e => e.type === 'word-too-long');
  assert.ok(err, '应有 word-too-long 错误');
  assert.match(err.message, /abcdefgh/);
  assert.match(err.message, /8 个盲文单元/);
});

test('总行数超容：报出原因且不裁切', () => {
  const r = Braille.layout({ text: 'a b c d e f', plateWidth: 30.9, plateHeight: 20, dotSpacing: 2.5, lineSpacing: 10, margin: 5 });
  // maxLines = floor((10-5)/10)+1 = 1，6 个单词各 1 单元 -> 需 3 行
  assert.equal(r.ok, false);
  const err = r.errors.find(e => e.type === 'too-many-lines');
  assert.ok(err, '应有 too-many-lines 错误');
  assert.match(err.message, /共需 3 行/);
  assert.equal(r.svg, null);
});

test('行距小于单元高度被拒绝', () => {
  const r = Braille.layout({ text: 'a', plateWidth: 100, plateHeight: 50, dotSpacing: 2.5, lineSpacing: 4 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /行距/.test(e.message)));
});

test('非法参数被拒绝', () => {
  const r = Braille.layout({ text: 'a', plateWidth: -1, plateHeight: 50, dotSpacing: 2.5, lineSpacing: 10 });
  assert.equal(r.ok, false);
  assert.ok(r.errors.length > 0);
});

test('空文本：合法空排版', () => {
  const r = Braille.layout({ text: '   ', ...FIT_ALL });
  assert.equal(r.ok, true);
  assert.equal(r.stats.totalLines, 0);
  assert.equal(r.dots.length, 0);
});
