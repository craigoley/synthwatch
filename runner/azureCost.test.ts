import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseCostRows, billingMonthParts } from './azureCost.js';

// ---- parseCostRows: column-NAME indexed, never positional (the order varies by account type) -------------

test('parseCostRows sums the Cost column found BY NAME, not by position', () => {
  // Currency first, Cost second — a positional [0]=cost reader would return the currency string as NaN.
  const payload = {
    properties: {
      columns: [{ name: 'Currency', type: 'String' }, { name: 'Cost', type: 'Number' }],
      rows: [['USD', 47.17]],
    },
  };
  assert.deepEqual(parseCostRows(payload), { total: 47.17, currency: 'USD' });
});

test('parseCostRows sums MULTIPLE rows (forecast: actual + forecast segments)', () => {
  const payload = {
    properties: {
      columns: [{ name: 'Cost' }, { name: 'CostStatus' }, { name: 'Currency' }],
      rows: [
        [47.17, 'Actual', 'USD'],
        [29.13, 'Forecast', 'USD'],
      ],
    },
  };
  const r = parseCostRows(payload)!;
  assert.equal(Math.round(r.total * 100) / 100, 76.3); // Azure's whole-month forecast
  assert.equal(r.currency, 'USD');
});

test('parseCostRows falls back to PreTaxCost / CostUSD naming (EA/MCA accounts)', () => {
  const payload = { properties: { columns: [{ name: 'PreTaxCost' }, { name: 'Currency' }], rows: [[12.5, 'EUR']] } };
  assert.deepEqual(parseCostRows(payload), { total: 12.5, currency: 'EUR' });
});

test('parseCostRows returns null on an unrecognizable shape (no Cost column) → caller shows the deep link', () => {
  assert.equal(parseCostRows({ properties: { columns: [{ name: 'Quantity' }], rows: [[3]] } }), null);
  assert.equal(parseCostRows({}), null);
  assert.equal(parseCostRows(null), null);
});

test('parseCostRows defaults currency to USD when the column is absent', () => {
  const payload = { properties: { columns: [{ name: 'Cost' }], rows: [[5]] } };
  assert.deepEqual(parseCostRows(payload), { total: 5, currency: 'USD' });
});

// ---- billingMonthParts: UTC month-boundary math (mtd_days denominator + forecast window) -----------------

test('billingMonthParts computes month start/end + days-elapsed in UTC', () => {
  const p = billingMonthParts(new Date('2026-07-16T09:00:00Z'));
  assert.equal(p.billingMonth, '2026-07-01');
  assert.equal(p.monthStart.toISOString().slice(0, 10), '2026-07-01');
  assert.equal(p.monthEnd.toISOString().slice(0, 10), '2026-07-31'); // July has 31 days
  assert.equal(p.mtdDays, 16); // 16d elapsed incl. today — matches the ground-truth "MTD (16d)"
});

test('billingMonthParts handles February end-of-month + day 1', () => {
  const feb = billingMonthParts(new Date('2026-02-01T00:30:00Z'));
  assert.equal(feb.billingMonth, '2026-02-01');
  assert.equal(feb.monthEnd.toISOString().slice(0, 10), '2026-02-28');
  assert.equal(feb.mtdDays, 1);
});
