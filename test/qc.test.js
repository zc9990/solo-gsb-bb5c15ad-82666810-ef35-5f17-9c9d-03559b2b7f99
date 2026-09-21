'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const QC = require('../lib/qc');

/* ---------- CSV 解析与行号定位 ---------- */

test('带表头解析，行号按物理行计算', () => {
  const { points, errors } = QC.parseMeasuredCsv('x_mm,y_mm\n5.1,4.9\n10,7.5\n');
  assert.equal(errors.length, 0);
  assert.deepEqual(points.map(p => [p.x, p.y, p.row]), [[5.1, 4.9, 2], [10, 7.5, 3]]);
});

test('无表头解析，行号从 1 开始；空行跳过', () => {
  const { points, errors } = QC.parseMeasuredCsv('5.1,4.9\n\n10,7.5\n');
  assert.equal(errors.length, 0);
  assert.deepEqual(points.map(p => p.row), [1, 3]);
});

test('容忍 BOM、空白与表头大小写', () => {
  const { points, errors } = QC.parseMeasuredCsv('﻿ X_MM , Y_MM \n 1 , 2 ');
  assert.equal(errors.length, 0);
  assert.deepEqual([points[0].x, points[0].y, points[0].row], [1, 2, 2]);
});

test('解析错误定位到具体行号与列号', () => {
  const { points, errors } = QC.parseMeasuredCsv('x_mm,y_mm\n5,5\nabc,3\n7\n8,8,8\n9,x');
  assert.equal(points.length, 1);
  assert.deepEqual(errors.map(e => e.line), [3, 4, 5, 6]);
  assert.match(errors[0].message, /第 3 行/);
  assert.match(errors[0].message, /第 1 列/);
  assert.match(errors[1].message, /列数为 1/);
  assert.match(errors[2].message, /列数为 3/);
});

/* ---------- 匹配规则 ---------- */

test('半径外的点不产生候选边', () => {
  const pairs = QC.solveMatching(2, 1, [{ i: 0, j: 0, d: 5 }, { i: 1, j: 0, d: 0.5 }]);
  assert.deepEqual(pairs, [{ i: 1, j: 0 }]);
});

test('一对一：实测点不得重复匹配，未配对设计点缺失', () => {
  const design = [{ x: 0, y: 0 }, { x: 0.4, y: 0 }];
  const r = QC.inspect({ design, csv: '0.1,0', tolerance: 0.5, maxRadius: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.pairs.length, 1);
  assert.equal(r.stats.missingCount, 1);
  const usedRows = r.pairs.map(p => p.csvRow);
  assert.equal(new Set(usedRows).size, usedRows.length);
});

test('匹配对数最多优先于总距离最小', () => {
  // m1 离 d1 略远，但若 d1-m2、d2-m1 可得 2 对；贪心最近邻会只得 1 对
  const design = [{ x: 0, y: 0 }, { x: 1, y: 0 }];
  const csv = '0,0\n1,0.3\n0,0';
  const r = QC.inspect({ design, csv, tolerance: 1, maxRadius: 1 });
  assert.equal(r.stats.matchedCount, 2);
});

test('同为最大配对数时取总欧氏距离最小', () => {
  // d0=(0,0) d1=(10,0)；m0 近 d0，m1 近 d1；交换配对距离显著更大
  const design = [{ x: 0, y: 0 }, { x: 10, y: 0 }];
  const r = QC.inspect({ design, csv: '0,1\n10,1', tolerance: 5, maxRadius: 12 });
  assert.deepEqual(r.pairs.map(p => [p.designIndex, p.csvRow]), [[1, 1], [2, 2]]);
  assert.ok(Math.abs(r.pairs[0].distance - 1) < 1e-9);
});

test('同成本按设计点序号与 CSV 行号稳定决胜', () => {
  const design = [{ x: 0, y: 0 }, { x: 2, y: 0 }];
  // 两个实测点完全重合于 (1,0)，两种配法成本相同
  const r1 = QC.inspect({ design, csv: '1,0\n1,0', tolerance: 5, maxRadius: 5 });
  assert.deepEqual(r1.pairs.map(p => [p.designIndex, p.csvRow]), [[1, 1], [2, 2]]);
  // 同一输入多次运行结果一致
  const r2 = QC.inspect({ design, csv: '1,0\n1,0', tolerance: 5, maxRadius: 5 });
  assert.deepEqual(r2.pairs, r1.pairs);
});

/* ---------- 判定与统计 ---------- */

test('偏移先应用再比较；合格/超差/缺失/多余四类齐全', () => {
  const design = [
    { x: 5, y: 5, r: 0.75 },
    { x: 11, y: 5, r: 0.75 },
    { x: 11, y: 7.5, r: 0.75 }
  ];
  // 实测整体偏 (-0.3, 0)：设置 offsetX=+0.3 后
  // 点1 残余 0.0（合格），点2 残余 0.6（超差），点3 无对应实测（缺失），(50,50) 多余
  const csv = '4.7,5\n10.1,5\n50,50';
  const r = QC.inspect({ design, csv, offsetX: 0.3, offsetY: 0, tolerance: 0.5, maxRadius: 2 });
  assert.equal(r.ok, true);
  const verdicts = r.pairs.map(p => p.verdict).sort();
  assert.deepEqual(verdicts, ['offset', 'pass']);
  assert.equal(r.stats.missingCount, 1);
  assert.equal(r.missing[0].designIndex, 3);
  assert.equal(r.stats.extraCount, 1);
  assert.equal(r.extra[0].csvRow, 3); // 无表头，物理行号
  assert.equal(r.stats.passCount, 1);
  // 通过率以设计点总数为分母：1/3
  assert.ok(Math.abs(r.stats.passRate - 1 / 3) < 1e-9);
  assert.equal(r.stats.maxDeviation, 0.6);
  assert.ok(Math.abs(r.stats.meanDeviation - 0.3) < 1e-9);
});

test('报告 CSV 含双方坐标、距离与中文结论', () => {
  const design = [{ x: 5, y: 5, r: 0.75 }];
  const r = QC.inspect({ design, csv: '5.2,4.9', tolerance: 0.5, maxRadius: 2 });
  assert.match(r.csv, /design_index,design_x_mm,design_y_mm,csv_row,measured_x_mm,measured_y_mm,corrected_x_mm,corrected_y_mm,distance_mm,conclusion/);
  assert.match(r.csv, /1,5,5,1,5.2,4.9,5.2,4.9,0\.2236,合格/);
  assert.match(r.csv, /pass_rate_percent/);
});

test('叠加 SVG 以四类颜色区分', () => {
  const design = [{ x: 5, y: 5, r: 0.75 }, { x: 11, y: 5, r: 0.75 }];
  const r = QC.inspect({
    design, csv: '5.2,4.9\n40,40',
    tolerance: 0.1, maxRadius: 2,
    plateWidth: 100, plateHeight: 50
  });
  assert.match(r.svg, /#16a34a|#d97706/); // 合格或超差
  assert.match(r.svg, /#dc2626/);         // 缺失
  assert.match(r.svg, /#7c3aed/);         // 多余
  assert.match(r.svg, /data-verdict="offset"/);
});

test('参数非法或 CSV 出错时 ok=false 且不给结论', () => {
  const design = [{ x: 5, y: 5 }];
  assert.equal(QC.inspect({ design, csv: '5,5', tolerance: 0, maxRadius: 2 }).ok, false);
  assert.equal(QC.inspect({ design, csv: '5,5', tolerance: 0.5, maxRadius: 0 }).ok, false);
  const r = QC.inspect({ design, csv: 'x,y\n5', tolerance: 0.5, maxRadius: 2 });
  assert.equal(r.ok, false);
  assert.equal(r.svg, null);
  assert.ok(r.errors.some(e => e.line === 2));
});

test('无设计点也无实测点时通过率 100%', () => {
  const r = QC.inspect({ design: [], csv: '', tolerance: 0.5, maxRadius: 2 });
  assert.equal(r.ok, true);
  assert.equal(r.stats.passRate, 1);
  assert.equal(r.stats.maxDeviation, null);
  assert.equal(r.stats.meanDeviation, null);
});

/* ---------- 自动校准（全局平移估算） ---------- */

test('自动校准：无序实测点 + 缺失点 + 多余点也能估中真实平移', () => {
  const design = [
    { x: 5, y: 5 }, { x: 11, y: 5 }, { x: 11, y: 7.5 },
    { x: 17, y: 5 }, { x: 17, y: 7.5 }
  ];
  // 实测整体平移 (+0.35, -0.20)（比较坐标 = 实测 + 偏移，故估算值应为 (-0.35, 0.2)）；
  // 顺序故意打乱，缺设计点 3，另混入一个多余点 (30,30)
  const csv =
    '17.35,7.30\n' +   // 对应设计点 5
    '5.35,4.80\n' +    // 对应设计点 1
    '30,30\n' +        // 多余
    '17.35,4.80\n' +   // 对应设计点 4
    '11.35,4.80\n';    // 对应设计点 2（设计点 3 缺失）
  const r = QC.estimateCalibration({
    design, csv, maxOffsetX: 2, maxOffsetY: 2, maxRadius: 0.3
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.offsetX - -0.35) < 1e-9, 'dx=' + r.offsetX);
  assert.ok(Math.abs(r.offsetY - 0.2) < 1e-9, 'dy=' + r.offsetY);
  assert.equal(r.matchedCount, 4); // 缺失 1 个设计点不影响匹配
});

test('自动校准：把估算偏移写回 inspect 后配对结果与真实平移一致', () => {
  const design = [{ x: 5, y: 5 }, { x: 11, y: 5 }, { x: 11, y: 7.5 }];
  const csv = '11.4,5.25\n5.4,5.25\n11.4,7.75'; // 乱序、整体 (+0.4,+0.25)
  const est = QC.estimateCalibration({ design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 0.2 });
  assert.equal(est.ok, true);
  const r = QC.inspect({
    design, csv, offsetX: est.offsetX, offsetY: est.offsetY,
    tolerance: 0.15, maxRadius: 0.2
  });
  assert.equal(r.stats.matchedCount, 3);
  assert.equal(r.stats.passCount, 3);
  assert.equal(r.stats.missingCount, 0);
  assert.equal(r.stats.extraCount, 0);
});

test('自动校准：候选平移两轴均限幅，超限候选被丢弃', () => {
  const design = [{ x: 5, y: 5 }, { x: 10, y: 5 }];
  // 真实平移 (+3,0)；X 最大校准量仅 1 -> 真实候选被剔除
  const csv = '8,5\n13,5';
  const r = QC.estimateCalibration({ design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 0.5 });
  assert.equal(r.ok, false);
  assert.equal(r.offsetX, null);
  assert.equal(r.offsetY, null);
  assert.match(r.errors[0].message, /没有落在/);
  // 放宽限幅后可估中
  const r2 = QC.estimateCalibration({ design, csv, maxOffsetX: 4, maxOffsetY: 1, maxRadius: 0.5 });
  assert.equal(r2.ok, true);
  assert.ok(Math.abs(r2.offsetX - -3) < 1e-9);
});

test('自动校准：优先级①匹配对数最多', () => {
  // maxRadius=0.15：
  //   候选 (0,0) 只能配 d2-m1（1 对）；
  //   候选 (-2,0) 可同时配 d1-m1、d2-m2（2 对）
  const design = [{ x: 0, y: 0 }, { x: 2, y: 0 }];
  const csv = '2,0\n4,0'; // 整体 (+2,0)
  const r = QC.estimateCalibration({ design, csv, maxOffsetX: 3, maxOffsetY: 1, maxRadius: 0.15 });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.offsetX - -2) < 1e-9);
  assert.equal(r.matchedCount, 2);
});

test('自动校准：优先级②匹配数相同时总残差最小', () => {
  // 三个候选平移都能配满 3 对（maxRadius 1），但各实测点残余方向不同：
  //   off=(-0.1,0)  总残差 0.5+0.0707≈0.5707（最小）
  //   off=(-0.2,0.1) 总残差 ≈0.5855
  //   off=(-0.4,-0.4) 总残差 ≈1.0148
  const design = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 12, y: 0 }];
  const csv = '0.4,0.4\n6.1,0\n12.15,-0.05';
  const r = QC.estimateCalibration({ design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 1 });
  assert.equal(r.ok, true);
  assert.equal(r.matchedCount, 3);
  assert.ok(Math.abs(r.offsetX - -0.1) < 1e-9, 'dx=' + r.offsetX);
  assert.equal(r.offsetY, 0);
  assert.ok(Math.abs(r.totalResidual - 0.5707) < 1e-4, 'res=' + r.totalResidual);
});

test('自动校准：优先级③|dx|+|dy| 最小，优先级④ dx/dy 升序', () => {
  // 单个设计点 (0,0)、两个实测点 (1,±1)，半径 3 内两个候选均为 2 对、总残差 2、
  // L1 均为 2、dx 均为 -1；dy 升序应选 (-1,-1)
  let r = QC.estimateCalibration({
    design: [{ x: 0, y: 0 }], csv: '1,1\n1,-1',
    maxOffsetX: 2, maxOffsetY: 2, maxRadius: 3
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.offsetX - -1) < 1e-9);
  assert.ok(Math.abs(r.offsetY - -1) < 1e-9);

  // 实测点 x=1 与 x=2：候选 -1 与 -2 都只配 1 对、残差 0；L1 更小的 -1 胜出
  r = QC.estimateCalibration({
    design: [{ x: 0, y: 0 }], csv: '2,0\n1,0',
    maxOffsetX: 2, maxOffsetY: 2, maxRadius: 0.5
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.offsetX - -1) < 1e-9);
  assert.equal(r.offsetY, 0);
});

test('自动校准：结果确定且不使用质心差', () => {
  // 10 个设计点缺失 6 个，且实测多出 4 个远点；质心差会被严重拉偏，
  // 候选匹配法仍应估中真实平移 (+0.2,+0.1)
  const design = [];
  for (let i = 0; i < 10; i++) design.push({ x: 5 + i * 6, y: 5 });
  // 仅前 4 个设计点有对应实测，另加 4 个远处多余点
  const measuredRows = [];
  for (let i = 0; i < 4; i++) measuredRows.push((5 + i * 6 + 0.2) + ',5.1');
  for (let k = 0; k < 4; k++) measuredRows.push((80 + k * 2) + ',40');
  const csv = measuredRows.join('\n');
  const r1 = QC.estimateCalibration({ design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 0.3 });
  const r2 = QC.estimateCalibration({ design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 0.3 });
  assert.equal(r1.ok, true);
  assert.ok(Math.abs(r1.offsetX - -0.2) < 1e-9);
  assert.ok(Math.abs(r1.offsetY - -0.1) < 1e-9);
  assert.equal(r1.matchedCount, 4);
  assert.deepEqual(r2, r1); // 同输入结果确定
});

test('自动校准：同一点对产生的相同平移去重为一个候选', () => {
  // 两个设计点相距 6，两个实测点也相距 6：真实平移候选由两个点对重复产生
  const design = [{ x: 0, y: 0 }, { x: 6, y: 0 }];
  const r = QC.estimateCalibration({
    design, csv: '0.5,0.2\n6.5,0.2',
    maxOffsetX: 1, maxOffsetY: 1, maxRadius: 0.3
  });
  assert.equal(r.ok, true);
  assert.equal(r.candidateCount, 1); // (-0.5,-0.2) 重复候选只计一次
  assert.equal(r.matchedCount, 2);
});

test('自动校准：参数非法、CSV 错误或缺点时 ok=false 且保留错误', () => {
  const design = [{ x: 5, y: 5 }];
  assert.equal(QC.estimateCalibration({ design, csv: '5,5', maxOffsetX: -1, maxOffsetY: 1, maxRadius: 2 }).ok, false);
  assert.equal(QC.estimateCalibration({ design, csv: '5,5', maxOffsetX: 1, maxOffsetY: 1, maxRadius: 0 }).ok, false);
  assert.equal(QC.estimateCalibration({ design, csv: '5,5', maxOffsetX: 1, maxOffsetY: 1 }).ok, false);
  const csvErr = QC.estimateCalibration({ design, csv: 'x,y\na,b', maxOffsetX: 1, maxOffsetY: 1, maxRadius: 2 });
  assert.equal(csvErr.ok, false);
  assert.ok(csvErr.errors.some(e => e.line === 2));
  assert.equal(QC.estimateCalibration({ design, csv: '', maxOffsetX: 1, maxOffsetY: 1, maxRadius: 2 }).ok, false);
  assert.equal(QC.estimateCalibration({ design: [], csv: '5,5', maxOffsetX: 1, maxOffsetY: 1, maxRadius: 2 }).ok, false);
});
