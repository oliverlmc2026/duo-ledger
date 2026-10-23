const test = require('node:test');
const assert = require('node:assert');
const C = require('./core.js');

const e = (id, payer, amount, extra = {}) => ({ id, type: 'expense', shared: true, amount, payer, updatedAt: 1, deleted: false, settlementId: null, ...extra });

test('parsePence uses integers', () => {
  assert.equal(C.parsePence('12.5'), 1250);
  assert.equal(C.parsePence('£0.07'), 7);
  assert.equal(C.parsePence('19.99'), 1999);
  assert.equal(C.parsePence('1.234'), null);
  assert.equal(C.parsePence('0'), null);
  assert.equal(C.parsePence('abc'), null);
});

test('evalPence evaluates calculator expressions', () => {
  assert.equal(C.evalPence('12.5'), 1250);
  assert.equal(C.evalPence('12+3.5'), 1550);
  assert.equal(C.evalPence('2+3×4'), 1400);
  assert.equal(C.evalPence('10÷4'), 250);
  assert.equal(C.evalPence('0.1+0.2'), 30);
  assert.equal(C.evalPence('20-5-3'), 1200);
  assert.equal(C.evalPence('12+'), 1200);
  assert.equal(C.evalPence('10÷3'), 333);
  assert.equal(C.evalPence('5-5'), null);
  assert.equal(C.evalPence('5-9'), null);
  assert.equal(C.evalPence('5÷0'), null);
  assert.equal(C.evalPence(''), null);
  assert.equal(C.evalPence('+5'), null);
});

test('odd total: debtor bears the extra penny', () => {
  const b = C.computeBalance([e('1', 'A', 101)], 'A', 'B');
  assert.deepEqual(b.transfer, { from: 'B', to: 'A', amount: 51 });
  const b2 = C.computeBalance([e('1', 'A', 101), e('2', 'B', 100)], 'A', 'B');
  assert.deepEqual(b2.transfer, { from: 'B', to: 'A', amount: 1 });
  const b3 = C.computeBalance([e('1', 'A', 100), e('2', 'B', 101)], 'A', 'B');
  assert.deepEqual(b3.transfer, { from: 'A', to: 'B', amount: 1 });
});

test('even split and equal payments need no transfer', () => {
  assert.equal(C.computeBalance([e('1', 'A', 500), e('2', 'B', 500)], 'A', 'B').transfer.amount, 0);
  assert.equal(C.computeBalance([e('1', 'A', 1000)], 'A', 'B').transfer.amount, 500);
});

test('merge: latest wins and deletion does not resurrect', () => {
  const mine = [e('1', 'A', 100, { updatedAt: 5 })];
  const theirs = [e('1', 'A', 100, { updatedAt: 9, deleted: true })];
  const r = C.mergeById(mine, theirs);
  assert.equal(r.records[0].deleted, true);
  const back = C.mergeById(r.records, [e('1', 'A', 100, { updatedAt: 5 })]);
  assert.equal(back.records[0].deleted, true);
  assert.equal(back.changed, 0);
});

test('merge dedupes by id and is symmetric', () => {
  const a = [e('1', 'A', 100), e('2', 'A', 200, { updatedAt: 3 })];
  const b = [e('2', 'A', 250, { updatedAt: 4 }), e('3', 'B', 300)];
  const ab = C.mergeById(a, b).records.sort((x, y) => x.id.localeCompare(y.id));
  const ba = C.mergeById(b, a).records.sort((x, y) => x.id.localeCompare(y.id));
  assert.deepEqual(ab, ba);
  assert.equal(ab.length, 3);
});

test('code round trip with unicode, and rejects junk', () => {
  const p = { v: 1, from: '小明', entries: [e('1', '小明', 100, { note: '飯 🍜' })], settlements: [] };
  assert.deepEqual(C.decodeCode(C.encodeCode(p)), p);
  assert.throws(() => C.decodeCode('hello'), /bad-code/);
  assert.throws(() => C.decodeCode('DL1:!!!'), /bad-code/);
});

test('import identifies partner and refuses own code or a third person', () => {
  const state = { profile: { name: 'A' }, partner: null, entries: [], settlements: [] };
  const code = { v: 1, from: 'B', entries: [e('1', 'B', 100)], settlements: [] };
  const r = C.applyImport(state, code);
  assert.equal(r.state.partner, 'B');
  assert.equal(r.state.entries.length, 1);
  assert.throws(() => C.applyImport(state, { ...code, from: 'A' }), /same-name/);
  assert.throws(() => C.applyImport(r.state, { ...code, from: 'C' }), /other-partner/);
});

test('settle archives the period; both phones derive the same settlement id', () => {
  const entries = [e('1', 'A', 101), e('2', 'B', 40), e('3', 'A', 5, { deleted: true })];
  const s1 = C.settle(entries, [], 'A', 'B', 10);
  const s2 = C.settle([...entries].reverse(), [], 'B', 'A', 20);
  assert.equal(s1.settlement.id, s2.settlement.id);
  assert.deepEqual(s1.settlement.transfer, { from: 'B', to: 'A', amount: 31 });
  assert.equal(C.currentShared(s1.entries).length, 0);
  assert.equal(C.settle(s1.entries, s1.settlements, 'A', 'B', 30), null);
});

test('backup round trips and restores onto an empty phone', () => {
  const full = { profile: { name: 'A' }, partner: 'B', lang: 'zh', categories: [{ id: 'c-1', kind: 'expense', name: '貓' }], entries: [e('1', 'A', 100, { shared: false })], settlements: [] };
  const back = C.decodeBackup(C.encodeBackup(full));
  assert.deepEqual(back, full);
  const empty = { profile: null, partner: null, lang: 'en', categories: [{ id: 'food', kind: 'expense', name: null }], entries: [], settlements: [] };
  const r = C.restoreBackup(empty, back);
  assert.equal(r.profile.name, 'A');
  assert.equal(r.partner, 'B');
  assert.equal(r.entries.length, 1);
  assert.equal(r.categories.length, 2);
  assert.equal(r.lang, 'en');
});

test('restore keeps newer local edits and refuses another person', () => {
  const local = { profile: { name: 'A' }, partner: 'B', categories: [], entries: [e('1', 'A', 999, { updatedAt: 9 })], settlements: [] };
  const old = { profile: { name: 'A' }, partner: 'B', categories: [], entries: [e('1', 'A', 100, { updatedAt: 2 }), e('2', 'A', 5)], settlements: [] };
  const r = C.restoreBackup(local, old);
  assert.equal(r.entries.find((x) => x.id === '1').amount, 999);
  assert.equal(r.entries.length, 2);
  assert.throws(() => C.restoreBackup(local, { ...old, profile: { name: 'Z' } }), /other-person/);
  assert.throws(() => C.decodeBackup(C.encodeCode({ v: 1, from: 'x', entries: [], settlements: [] })), /bad-code/);
});

test('decodeCode survives what chat apps and iOS paste add around a code', () => {
  const p = { v: 1, from: 'A', entries: [{ id: 'x', note: '午餐', amount: 100 }], settlements: [] };
  const c = C.encodeCode(p);
  const mid = Math.floor(c.length / 2);
  for (const wrapped of [
    c.slice(0, mid) + '\n' + c.slice(mid),
    c.slice(0, mid) + '​' + c.slice(mid),
    '​' + c + '​',
    '“' + c + '”',
    '我的碼：' + c + ' 收到請回覆',
  ]) assert.deepEqual(C.decodeCode(wrapped), p);
  assert.throws(() => C.decodeCode('DL1:'), /bad-code/);
});

test('decodeCode and decodeBackup accept a lowercased prefix as iOS Safari delivers it', () => {
  const p = { v: 1, from: 'A', entries: [], settlements: [] };
  const c = C.encodeCode(p);
  assert.deepEqual(C.decodeCode('dl1:' + c.slice(4)), p);
  const state = { entries: [], settlements: [], categories: [] };
  const b = C.encodeBackup(state);
  assert.deepEqual(C.decodeBackup('dlb1:' + b.slice(5)), state);
});

test('code leaves out entries of settlements older than the latest two', () => {
  let entries = [], settlements = [];
  for (let i = 1; i <= 3; i++) {
    entries = [...entries, e('p' + i, 'A', 10 * i)];
    ({ entries, settlements } = C.settle(entries, settlements, 'A', 'B', i));
  }
  const payload = C.buildPayload({ profile: { name: 'A' }, entries: [...entries, e('open', 'A', 7)], settlements });
  assert.deepEqual(payload.entries.map((x) => x.id).sort(), ['open', 'p2', 'p3']);
});

test('an entry settled before it was ever sent still reaches the partner', () => {
  const synced = [e('1', 'A', 100, { date: '2026-10-01' }), e('2', 'B', 40, { date: '2026-10-02' })];
  const aEntries = [...synced, e('x', 'A', 30, { date: '2026-10-03' })];
  const settled = C.settle(aEntries, [], 'A', 'B', 10);
  const aState = { profile: { name: 'A' }, partner: 'B', entries: settled.entries, settlements: settled.settlements };
  const bState = { profile: { name: 'B' }, partner: 'A', entries: synced, settlements: [] };
  const r = C.applyImport(bState, C.decodeCode(C.encodeCode(C.buildPayload(aState)))).state;
  assert.deepEqual(C.settledEntries(r.entries, settled.settlement.id).map((x) => x.id).sort(), ['1', '2', 'x']);
  assert.deepEqual(C.currentShared(r.entries), []);
});

test('code closes settled entries on the partner phone', () => {
  const mine = [e('1', 'A', 100), e('2', 'B', 40)];
  const settled = C.settle(mine, [], 'A', 'B', 10);
  const open = e('3', 'A', 7);
  const aState = { profile: { name: 'A' }, partner: 'B', entries: [...settled.entries, open], settlements: settled.settlements };
  const payload = C.buildPayload(aState);
  const bState = { profile: { name: 'B' }, partner: 'A', entries: mine, settlements: [] };
  const r = C.applyImport(bState, C.decodeCode(C.encodeCode(payload))).state;
  assert.deepEqual(r.entries.filter((x) => x.settlementId).map((x) => x.id).sort(), ['1', '2']);
  assert.equal(r.settlements.length, 1);
  assert.deepEqual(C.currentShared(r.entries).map((x) => x.id), ['3']);
});

test('settledEntries lists one period newest first, without other periods or open entries', () => {
  const first = C.settle([e('1', 'A', 10, { date: '2026-10-01' }), e('2', 'B', 20, { date: '2026-10-03' })], [], 'A', 'B', 5);
  const entries = [...first.entries, e('3', 'A', 30, { date: '2026-10-05' })];
  assert.deepEqual(C.settledEntries(entries, first.settlement.id).map((x) => x.id), ['2', '1']);
  assert.deepEqual(C.settledEntries(entries, 'nope'), []);
});

test('deleted shared entries age out of the code with the period they were settled in', () => {
  let entries = [], settlements = [];
  for (let i = 1; i <= 3; i++) {
    entries = [...entries, e('k' + i, 'A', 100), e('d' + i, 'A', 50, { deleted: true })];
    ({ entries, settlements } = C.settle(entries, settlements, 'A', 'B', 1700000000000 + i));
  }
  const payload = C.buildPayload({ profile: { name: 'A' }, entries, settlements });
  assert.deepEqual(payload.entries.filter((x) => x.deleted).map((x) => x.id).sort(), ['d2', 'd3']);
  assert.deepEqual(settlements.find((s) => s.closedAt === 1700000000003).ids, ['k3']);
});

test('a deletion settled away still reaches the partner', () => {
  const settled = C.settle([e('k', 'A', 100), e('d', 'A', 50, { deleted: true, updatedAt: 2 })], [], 'A', 'B', 10);
  const aState = { profile: { name: 'A' }, partner: 'B', entries: settled.entries, settlements: settled.settlements };
  const bState = { profile: { name: 'B' }, partner: 'A', entries: [e('k', 'A', 100), e('d', 'A', 50)], settlements: [] };
  const r = C.applyImport(bState, C.decodeCode(C.encodeCode(C.buildPayload(aState)))).state;
  assert.equal(r.entries.find((x) => x.id === 'd').deleted, true);
});

test('code size stays bounded as settlements pile up', () => {
  let entries = [], settlements = [];
  const size = () => C.encodeCode(C.buildPayload({ profile: { name: 'A' }, entries, settlements })).length;
  let after5;
  for (let i = 1; i <= 20; i++) {
    entries = [...entries, e('a' + String(i).padStart(2, '0'), 'A', 100 + i), e('b' + String(i).padStart(2, '0'), 'B', 50 + i)];
    const r = C.settle(entries, settlements, 'A', 'B', 1700000000000 + i);
    entries = r.entries; settlements = r.settlements;
    if (i === 5) after5 = size();
  }
  assert.ok(size() <= after5 + 8);
});
