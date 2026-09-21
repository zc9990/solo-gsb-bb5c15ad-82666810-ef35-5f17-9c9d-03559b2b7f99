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

test('报告 CSV 含双方坐标、距离、角度与中文结论', () => {
  const design = [{ x: 5, y: 5, r: 0.75 }];
  const r = QC.inspect({ design, csv: '5.2,4.9', tolerance: 0.5, maxRadius: 2 });
  assert.match(r.csv, /design_index,design_x_mm,design_y_mm,csv_row,measured_x_mm,measured_y_mm,corrected_x_mm,corrected_y_mm,distance_mm,conclusion,rotation_deg/);
  assert.match(r.csv, /1,5,5,1,5\.2,4\.9,5\.2,4\.9,0\.2236,合格,0/);
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

/* ---------- 小角度刚体校准 ---------- */

// 围绕中心旋转点（与 lib/qc.js 同一约定：逆时针为正）
function rotate(x, y, cx, cy, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  const rx = x - cx, ry = y - cy;
  return [cx + c * rx - s * ry, cy + s * rx + c * ry];
}

const RIGID_DESIGN = [
  { x: 20, y: 15 }, { x: 80, y: 15 }, { x: 50, y: 25 },
  { x: 20, y: 38 }, { x: 80, y: 38 }
];
const PLATE = { plateWidth: 100, plateHeight: 50 };

function csvOf(points) {
  return points.map(p => p[0].toFixed(6) + ',' + p[1].toFixed(6)).join('\n');
}

test('刚体校准：纯旋转实测可估中旋转角（角度取反），旋转中心为板材中心', () => {
  // 实测 = 设计围绕 (50,25) 旋转 +1.2°；校准角应为 -1.2°、偏移为 0
  const measured = RIGID_DESIGN.map(d => rotate(d.x, d.y, 50, 25, 1.2));
  const r = QC.estimateCalibration({
    design: RIGID_DESIGN, csv: csvOf(measured),
    maxOffsetX: 2, maxOffsetY: 2, maxRadius: 0.5,
    maxAngle: 3, angleStep: 0.1, ...PLATE
  });
  assert.equal(r.ok, true);
  assert.equal(r.rigidMode, true);
  assert.ok(Math.abs(r.rotation - -1.2) < 1e-9, 'rotation=' + r.rotation);
  assert.ok(Math.abs(r.offsetX) < 1e-9, 'dx=' + r.offsetX);
  assert.ok(Math.abs(r.offsetY) < 1e-9, 'dy=' + r.offsetY);
  assert.equal(r.matchedCount, 5);
  assert.ok(Math.abs(r.totalResidual) < 1e-9);
  assert.equal(r.centerX, 50);
  assert.equal(r.centerY, 25);
  assert.equal(r.angleCount, 61); // -3.0..3.0 步长 0.1
});

test('刚体校准：旋转 + 平移联合偏差可同时估中角度与 dx/dy', () => {
  // 实测 = 旋转(+1.7°) 后再整体 (+0.4,-0.3)
  const measured = RIGID_DESIGN.map(d => {
    const p = rotate(d.x, d.y, 50, 25, 1.7);
    return [p[0] + 0.4, p[1] - 0.3];
  });
  const r = QC.estimateCalibration({
    design: RIGID_DESIGN, csv: csvOf(measured),
    maxOffsetX: 2, maxOffsetY: 2, maxRadius: 0.3,
    maxAngle: 3, angleStep: 0.1, ...PLATE
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.rotation - -1.7) < 1e-9, 'rotation=' + r.rotation);
  assert.ok(Math.abs(r.offsetX - -0.4) < 0.02, 'dx=' + r.offsetX);
  assert.ok(Math.abs(r.offsetY - 0.3) < 0.02, 'dy=' + r.offsetY);
  assert.equal(r.matchedCount, 5);
});

test('刚体校准：写回角度与偏移后重跑 inspect，四类判定全部合格', () => {
  const measured = RIGID_DESIGN.map(d => {
    const p = rotate(d.x, d.y, 50, 25, 0.9);
    return [p[0] - 0.25, p[1] + 0.15];
  });
  const csv = csvOf(measured);
  const est = QC.estimateCalibration({
    design: RIGID_DESIGN, csv,
    maxOffsetX: 1, maxOffsetY: 1, maxRadius: 0.3,
    maxAngle: 2, angleStep: 0.1, ...PLATE
  });
  assert.equal(est.ok, true);
  assert.ok(Math.abs(est.rotation - -0.9) < 1e-9, 'rotation=' + est.rotation);
  const q = QC.inspect({
    design: RIGID_DESIGN, csv,
    offsetX: est.offsetX, offsetY: est.offsetY, rotation: est.rotation,
    tolerance: 0.05, maxRadius: 0.3, ...PLATE
  });
  assert.equal(q.ok, true);
  assert.equal(q.stats.passCount, 5);
  assert.equal(q.stats.matchedCount, 5);
  assert.equal(q.stats.missingCount, 0);
  assert.equal(q.stats.extraCount, 0);
  assert.equal(q.params.rotation, est.rotation);
});

test('刚体校准：pairs 同时记录原始坐标、校正坐标与角度，CSV 参数行含旋转角/中心', () => {
  const measured = RIGID_DESIGN.map(d => rotate(d.x, d.y, 50, 25, 0.5));
  const q = QC.inspect({
    design: RIGID_DESIGN, csv: csvOf(measured),
    rotation: -0.5, tolerance: 0.01, maxRadius: 0.1, ...PLATE
  });
  assert.equal(q.pairs.length, 5);
  const p0 = q.pairs[0];
  // 原始坐标为未旋转实测（输出按 4 位小数），校正坐标贴近设计点
  assert.ok(Math.abs(p0.measuredX - measured[0][0]) < 1e-4);
  assert.ok(Math.abs(p0.measuredY - measured[0][1]) < 1e-4);
  assert.ok(Math.abs(p0.correctedX - p0.designX) < 1e-6);
  assert.ok(Math.abs(p0.correctedY - p0.designY) < 1e-6);
  assert.match(q.csv, /rotation_deg/);
  assert.match(q.csv, /,-0\.5$/m); // 明细末列角度
  assert.match(q.csv, /# params,offset_x_mm,offset_y_mm,rotation_deg,rotation_center_x_mm,rotation_center_y_mm/);
  assert.match(q.svg, /data-rotation="-0.5"/);
  assert.match(q.svg, /data-center-x="50"/);
});

test('刚体校准：叠加 SVG 的校正点带原始测量坐标与角度数据', () => {
  const measured = RIGID_DESIGN.map(d => rotate(d.x, d.y, 50, 25, 0.5));
  const q = QC.inspect({
    design: RIGID_DESIGN, csv: csvOf(measured),
    rotation: -0.5, tolerance: 0.01, maxRadius: 0.1, ...PLATE
  });
  assert.match(q.svg, new RegExp('data-measured-x="' + q.pairs[0].measuredX + '"'));
  assert.match(q.svg, /旋转 -0.5°/);
});

test('刚体校准：优先级③匹配数与残差相同时偏好旋转绝对值最小（0°）', () => {
  // 实测与设计完全一致；大半径下多个角度都能配满、残差近似为 0，应选角度 0
  const csv = RIGID_DESIGN.map(d => d.x + ',' + d.y).join('\n');
  const r = QC.estimateCalibration({
    design: RIGID_DESIGN, csv,
    maxOffsetX: 1, maxOffsetY: 1, maxRadius: 5,
    maxAngle: 2, angleStep: 0.5, ...PLATE
  });
  assert.equal(r.ok, true);
  assert.equal(r.rotation, 0);
  assert.equal(r.offsetX, 0);
  assert.equal(r.offsetY, 0);
});

test('刚体校准：旋转使真实解落在纯平移限幅之外时，仅平移估不准、刚体可以', () => {
  // 角点 (20,15) 旋转 2° 后位移约 1.2mm，超过 0.3mm 的平移限幅
  const measured = RIGID_DESIGN.map(d => rotate(d.x, d.y, 50, 25, 2));
  const csv = csvOf(measured);
  const plain = QC.estimateCalibration({
    design: RIGID_DESIGN, csv,
    maxOffsetX: 0.3, maxOffsetY: 0.3, maxRadius: 0.2, ...PLATE
  });
  // 中心点 (50,25) 旋转不动：纯平移至少能配 1 对，但配不满 5 对
  if (plain.ok) assert.ok(plain.matchedCount < 5);
  const rigid = QC.estimateCalibration({
    design: RIGID_DESIGN, csv,
    maxOffsetX: 0.3, maxOffsetY: 0.3, maxRadius: 0.2,
    maxAngle: 3, angleStep: 0.1, ...PLATE
  });
  assert.equal(rigid.ok, true);
  assert.ok(Math.abs(rigid.rotation - -2) < 1e-9, 'rotation=' + rigid.rotation);
  assert.equal(rigid.matchedCount, 5);
});

test('刚体校准：缺失设计点与多余实测点不影响角度估计（不使用质心差）', () => {
  const design = RIGID_DESIGN.concat([{ x: 50, y: 8 }]);
  const measured = RIGID_DESIGN.map(d => rotate(d.x, d.y, 50, 25, 0.8));
  measured.push([96, 47]); // 多余点；最后一个设计点缺失
  const r = QC.estimateCalibration({
    design, csv: csvOf(measured),
    maxOffsetX: 1, maxOffsetY: 1, maxRadius: 0.2,
    maxAngle: 2, angleStep: 0.1, ...PLATE
  });
  assert.equal(r.ok, true);
  assert.ok(Math.abs(r.rotation - -0.8) < 1e-9);
  assert.equal(r.matchedCount, 5);
});

test('刚体校准：角度与平移范围内无有效候选时 ok=false 并保留原参数语义', () => {
  const design = [{ x: 20, y: 15 }, { x: 80, y: 15 }, { x: 20, y: 38 }];
  const measured = design.map(d => rotate(d.x, d.y, 50, 25, 2.5));
  const r = QC.estimateCalibration({
    design, csv: csvOf(measured),
    maxOffsetX: 0.2, maxOffsetY: 0.2, maxRadius: 0.1,
    maxAngle: 0.5, angleStep: 0.1, ...PLATE
  });
  assert.equal(r.ok, false);
  assert.equal(r.rotation, null);
  assert.equal(r.offsetX, null);
  assert.equal(r.offsetY, null);
  assert.match(r.errors[0].message, /没有任何可评估候选/);
});

test('刚体校准：角度参数非法或超范围时 ok=false', () => {
  const design = [{ x: 20, y: 15 }];
  const csv = '20,15';
  assert.equal(QC.estimateCalibration({
    design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 1, maxAngle: -1, angleStep: 0.1
  }).ok, false);
  assert.equal(QC.estimateCalibration({
    design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 1, maxAngle: 2, angleStep: 0
  }).ok, false);
  // 只传最大角不传步长：明确报错而非静默退化为纯平移
  const onlyAngle = QC.estimateCalibration({
    design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 1, maxAngle: -0.5
  });
  assert.equal(onlyAngle.ok, false);
  assert.match(onlyAngle.errors[0].message, /最大旋转角/);
  const missingStep = QC.estimateCalibration({
    design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 1, maxAngle: 2
  });
  assert.equal(missingStep.ok, false);
  assert.match(missingStep.errors[0].message, /角度步长/);
  // 超过小角度上限 15°
  assert.match(QC.estimateCalibration({
    design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 1, maxAngle: 20, angleStep: 0.1
  }).errors[0].message, /超出小角度/);
});

test('刚体校准：不传角度参数时与旧纯平移调用完全兼容', () => {
  const design = [{ x: 5, y: 5 }, { x: 11, y: 5 }, { x: 11, y: 7.5 }];
  const csv = '11.4,5.25\n5.4,5.25\n11.4,7.75';
  const r = QC.estimateCalibration({ design, csv, maxOffsetX: 1, maxOffsetY: 1, maxRadius: 0.2 });
  assert.equal(r.ok, true);
  assert.equal(r.rigidMode, false);
  assert.equal(r.rotation, 0);
  assert.equal(r.angleCount, null);
  assert.ok(Math.abs(r.offsetX - -0.4) < 1e-9);
  assert.ok(Math.abs(r.offsetY - -0.25) < 1e-9);
});

test('刚体校准：无板材幅面时旋转中心退化为设计点包围盒中心', () => {
  const design = [{ x: 20, y: 10 }, { x: 80, y: 40 }];
  const measured = design.map(d => rotate(d.x, d.y, 50, 25, 1.0));
  const r = QC.estimateCalibration({
    design, csv: csvOf(measured),
    maxOffsetX: 1, maxOffsetY: 1, maxRadius: 0.2,
    maxAngle: 2, angleStep: 0.1
  });
  assert.equal(r.ok, true);
  assert.equal(r.centerX, 50);
  assert.equal(r.centerY, 25);
  assert.ok(Math.abs(r.rotation - -1) < 1e-9);
  assert.equal(r.matchedCount, 2);
});

test('inspect 不传 rotation 时行为与旧版一致（旋转 0）', () => {
  const design = [{ x: 5, y: 5, r: 0.75 }];
  const r = QC.inspect({ design, csv: '5.2,4.9', tolerance: 0.5, maxRadius: 2 });
  assert.equal(r.params.rotation, 0);
  assert.ok(Math.abs(r.pairs[0].distance - 0.2236) < 1e-3);
});
