(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const CODE_PREFIX = 'DL1:';

  const BUILTIN_CATEGORIES = [
    { id: 'food', kind: 'expense' },
    { id: 'transport', kind: 'expense' },
    { id: 'shopping', kind: 'expense' },
    { id: 'home', kind: 'expense' },
    { id: 'fun', kind: 'expense' },
    { id: 'other', kind: 'expense' },
    { id: 'salary', kind: 'income' },
    { id: 'other-in', kind: 'income' },
  ];

  function parsePence(text) {
    const m = /^\s*£?\s*(\d+)(?:\.(\d{1,2}))?\s*$/.exec(String(text));
    if (!m) return null;
    const pence = Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0') || 0);
    return Number.isSafeInteger(pence) && pence > 0 ? pence : null;
  }

  function formatPence(p) {
    const sign = p < 0 ? '-' : '';
    const a = Math.abs(p);
    return sign + '£' + Math.floor(a / 100).toLocaleString('en-GB') + '.' + String(a % 100).padStart(2, '0');
  }

  function newId() {
    const r = new Uint8Array(8);
    (typeof crypto !== 'undefined' ? crypto : require('crypto').webcrypto).getRandomValues(r);
    return Date.now().toString(36) + Array.from(r, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function wins(a, b) {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
    return JSON.stringify(a) >= JSON.stringify(b);
  }

  function mergeById(local, incoming) {
    const map = new Map(local.map((r) => [r.id, r]));
    let changed = 0;
    for (const r of incoming) {
      const cur = map.get(r.id);
      if (!cur || (!wins(cur, r) && JSON.stringify(cur) !== JSON.stringify(r))) {
        map.set(r.id, r);
        changed++;
      }
    }
    return { records: [...map.values()], changed };
  }

  function currentShared(entries) {
    return entries.filter((e) => e.shared && !e.deleted && !e.settlementId);
  }

  // Debtor (who paid less) absorbs the odd penny.
  function computeBalance(entries, me, partner) {
    const paid = { [me]: 0, [partner || '']: 0 };
    let total = 0;
    for (const e of entries) {
      if (e.type !== 'expense') continue;
      paid[e.payer] = (paid[e.payer] || 0) + e.amount;
      total += e.amount;
    }
    const names = [me, partner].filter(Boolean);
    const half = Math.floor(total / 2);
    let transfer = { from: null, to: null, amount: 0 };
    if (names.length === 2) {
      const [a, b] = names;
      const pa = paid[a] || 0, pb = paid[b] || 0;
      if (pa !== pb) {
        const [creditor, debtor] = pa > pb ? [a, b] : [b, a];
        transfer = { from: debtor, to: creditor, amount: Math.max(pa, pb) - half };
      }
    }
    return { total, paid, transfer };
  }

  function hashIds(ids) {
    let h = 0x811c9dc5;
    for (const ch of ids.slice().sort().join('|')) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return 's-' + h.toString(16);
  }

  function settle(entries, settlements, me, partner, now) {
    const open = currentShared(entries).filter((e) => e.type === 'expense');
    if (!open.length) return null;
    const id = hashIds(open.map((e) => e.id));
    const bal = computeBalance(open, me, partner);
    const settlement = {
      id,
      closedAt: now,
      updatedAt: now,
      total: bal.total,
      paid: bal.paid,
      transfer: bal.transfer,
      count: open.length,
      deleted: false,
    };
    const ids = new Set(open.map((e) => e.id));
    return {
      settlement,
      entries: entries.map((e) => (ids.has(e.id) ? { ...e, settlementId: id, updatedAt: now } : e)),
      settlements: mergeById(settlements, [settlement]).records,
    };
  }

  function encodeWith(prefix, payload) {
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return prefix + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function decodeWith(prefix, text, isValid) {
    const t = String(text).trim();
    if (!t.startsWith(prefix)) throw new Error('bad-code');
    try {
      const b64 = t.slice(prefix.length).replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
      const obj = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
      if (!isValid(obj)) throw 0;
      return obj;
    } catch (_) {
      throw new Error('bad-code');
    }
  }

  const encodeCode = (p) => encodeWith(CODE_PREFIX, p);
  const decodeCode = (t) =>
    decodeWith(CODE_PREFIX, t, (o) => o.v === 1 && typeof o.from === 'string' && Array.isArray(o.entries) && Array.isArray(o.settlements));

  const BACKUP_PREFIX = 'DLB1:';
  const encodeBackup = (state) => encodeWith(BACKUP_PREFIX, { v: 1, state });
  const decodeBackup = (t) =>
    decodeWith(BACKUP_PREFIX, t, (o) => o.v === 1 && o.state && Array.isArray(o.state.entries) && Array.isArray(o.state.settlements) && Array.isArray(o.state.categories)).state;

  // Merge, never overwrite: restoring onto a phone that already has data keeps the newer edit per record.
  function restoreBackup(state, backup) {
    const profile = state.profile || backup.profile;
    if (state.profile && backup.profile && state.profile.name !== backup.profile.name) throw new Error('other-person');
    const e = mergeById(state.entries, backup.entries);
    const s = mergeById(state.settlements, backup.settlements);
    const known = new Set(state.categories.map((c) => c.id));
    return {
      ...state,
      profile,
      partner: state.partner || backup.partner || null,
      categories: [...state.categories, ...backup.categories.filter((c) => !known.has(c.id))],
      entries: e.records,
      settlements: s.records,
    };
  }

  function buildPayload(state) {
    return {
      v: 1,
      from: state.profile.name,
      entries: state.entries.filter((e) => e.shared),
      settlements: state.settlements,
    };
  }

  function applyImport(state, payload) {
    if (payload.from === state.profile.name) throw new Error('same-name');
    if (state.partner && state.partner !== payload.from) throw new Error('other-partner');
    const e = mergeById(state.entries, payload.entries);
    const s = mergeById(state.settlements, payload.settlements);
    return {
      state: { ...state, partner: payload.from, entries: e.records, settlements: s.records },
      changed: e.changed + s.changed,
    };
  }

  return { BUILTIN_CATEGORIES, parsePence, formatPence, newId, mergeById, currentShared, computeBalance, settle, encodeCode, decodeCode, encodeBackup, decodeBackup, restoreBackup, buildPayload, applyImport };
});
