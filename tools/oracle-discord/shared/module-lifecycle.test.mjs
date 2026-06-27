import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  startModuleInterval,
  clearModuleIntervals,
  getModuleIntervalCount,
  registerShutdownHook,
  runShutdownHooks,
} from './module-lifecycle.mjs';

test('startModuleInterval registers handles cleared by clearModuleIntervals', () => {
  clearModuleIntervals();
  assert.equal(getModuleIntervalCount(), 0);
  startModuleInterval(() => {}, 60_000);
  startModuleInterval(() => {}, 120_000);
  assert.equal(getModuleIntervalCount(), 2);
  clearModuleIntervals();
  assert.equal(getModuleIntervalCount(), 0);
});

test('registerShutdownHook runs all hooks in order', () => {
  const order = [];
  registerShutdownHook(() => order.push('a'));
  registerShutdownHook(() => order.push('b'));
  runShutdownHooks();
  assert.deepEqual(order.slice(-2), ['a', 'b']);
});