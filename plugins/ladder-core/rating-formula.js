'use strict';

// TT 天梯计分公式：结算和网页计算器共用这一份。
// 运行中修改本文件会在下一场结算 / 下一次预估时自动重新加载（见 index.js 的
// createLiveRatingFormula）；加载前会先跑自检，文件写坏或结果不合理时保留上一版。
// 本文件只能是纯函数：不读写文件、数据库或全局状态，不 require 其他模块。
//
// Shared TT ladder formula used by both settlement and the web calculator.
// Edits are hot-reloaded before the next settlement/preview after a self-check;
// a broken or implausible version is rejected and the last good one is kept.
// Keep this file pure: no I/O, no global state, no requires.

const MINIMUM_POINTS = 0;
const ELO_SCALE = 400;

function combinedPoints(totalPoints, monthPoints, rating) {
  return rating.totalWeight * Number(totalPoints) + rating.monthWeight * Number(monthPoints);
}

function calculateDelta(playerPoints, opponentPoints, won, rating) {
  if (!rating.useDynamic) return won ? Number(rating.fixedDelta) : -Number(rating.fixedDelta);
  const expected = 1 / (1 + Math.pow(10, (opponentPoints - playerPoints) / ELO_SCALE));
  const raw = Math.round(Number(rating.kFactor) * ((won ? 1 : 0) - expected));
  const magnitude = Math.max(Number(rating.minDelta), Math.min(Number(rating.maxDelta), Math.abs(raw)));
  return won ? magnitude : -magnitude;
}

const applyDelta = (points, delta) => Math.max(MINIMUM_POINTS, Number(points) + delta);

// players: [{total, month}, {total, month}]，均为结算前余额；winnerIndex: 0 或 1。
// 返回 delta 是公式算出的变化量（写入 Match 记录），after 是应用 0 分下限后的新余额。
// 加载器会强制 after === max(MINIMUM_POINTS, 原余额 + delta)，余额规则不能在这里另行改写。
function settleMatch(players, winnerIndex, rating) {
  const combined = players.map(player => combinedPoints(player.total, player.month, rating));
  const deltas = players.map((player, index) => calculateDelta(combined[index], combined[1 - index], index === winnerIndex, rating));
  const after = players.map((player, index) => ({
    total: applyDelta(player.total, deltas[index]),
    month: applyDelta(player.month, deltas[index])
  }));
  return {combined, deltas, after};
}

module.exports = {MINIMUM_POINTS, ELO_SCALE, combinedPoints, calculateDelta, settleMatch};
