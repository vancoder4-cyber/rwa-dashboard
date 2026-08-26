import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  SIGNAL_HISTORY_CHECKPOINTS,
  readSignalHistoryCheckpoints,
  writeSignalHistoryCheckpoints,
} from '../api/_lib/signal-history-checkpoint.js';

function transaction(results, calls) {
  return async build => {
    const sql = {
      query(text, params = []) {
        const query = { text, params };
        calls.push(query);
        return query;
      },
    };
    const queries = build(sql);
    return queries.map((query, index) => results[index] ?? []);
  };
}

test('durable Signal history is disabled without the explicit PostgreSQL mode', async () => {
  const result = await readSignalHistoryCheckpoints({ env:{} });
  assert.equal(result.mode, 'off');
  assert.equal(result.status, 'off');
  assert.deepEqual(result.values, {});
});

test('reads only checksummed, formula-matched durable history payloads', async () => {
  const calls = [];
  const namespace = 'rwa-signal-radar-v2';
  const payloadText = JSON.stringify([{ t:Date.parse('2026-08-26T03:00:00.000Z'), a:[] }]);
  const rows = [{
    namespace,
    formula_version:SIGNAL_HISTORY_CHECKPOINTS[namespace],
    observed_at:'2026-08-26T03:07:00.000Z',
    payload_text:payloadText,
    payload_sha256:createHash('sha256').update(payloadText).digest('hex'),
    payload_bytes:Buffer.byteLength(payloadText),
  }];
  const result = await readSignalHistoryCheckpoints({
    env:{ PG_WRITE_MODE:'shadow', DATABASE_URL:'postgresql://test.invalid/database' },
    runTransaction:transaction([[], rows], calls),
  });
  assert.equal(result.status, 'stored');
  assert.deepEqual(result.values[namespace], JSON.parse(payloadText));
  assert.match(calls[0].text, /^SET LOCAL ROLE rwa_signal_history_writer$/);
  assert.match(calls[1].text, /FROM publication\.signal_history_checkpoint/);

  rows[0].payload_sha256 = '0'.repeat(64);
  const corrupt = await readSignalHistoryCheckpoints({
    env:{ PG_WRITE_MODE:'shadow', DATABASE_URL:'postgresql://test.invalid/database' },
    runTransaction:transaction([[], rows], []),
  });
  assert.equal(corrupt.status, 'unavailable');
  assert.deepEqual(corrupt.values, {});
});

test('writes bounded checkpoints with a stale-writer fence', async () => {
  const calls = [];
  const namespace = 'rwa-signal-oi-liquidation-hourly-v1';
  const observedAt = '2026-08-26T03:07:00.000Z';
  const result = await writeSignalHistoryCheckpoints(
    { [namespace]:{ v:1, i:[], c:[], h:[] } },
    observedAt,
    {
      env:{ PG_WRITE_MODE:'required', DATABASE_URL:'postgresql://test.invalid/database' },
      runTransaction:transaction([[], [{ namespace, observed_at:observedAt }]], calls),
    },
  );
  assert.equal(result.status, 'stored');
  assert.equal(result.entries[namespace].status, 'stored');
  assert.match(calls[1].text, /ON CONFLICT \(namespace\) DO UPDATE/);
  assert.match(calls[1].text, /observed_at < EXCLUDED\.observed_at/);
  assert.match(calls[1].text, /payload_sha256 = EXCLUDED\.payload_sha256/);
  assert.equal(calls[1].params[0], namespace);

  const stale = await writeSignalHistoryCheckpoints(
    { [namespace]:{ v:1, i:[], c:[], h:[] } },
    observedAt,
    {
      env:{ PG_WRITE_MODE:'required', DATABASE_URL:'postgresql://test.invalid/database' },
      runTransaction:transaction([[], []], []),
    },
  );
  assert.equal(stale.status, 'stale');
  assert.equal(stale.entries[namespace].status, 'stale');
});
