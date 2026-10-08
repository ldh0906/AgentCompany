// 비밀값 가리기: 알려진 키 모양과 이름이 비밀값인 설정의 값만 가리고, SHA·토큰 수 같은 일반 값은 그대로 둔다
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { REDACTED, redact, redactDeep } from '../../src/core/redact.ts';

test('알려진 키 모양을 가린다', () => {
  const samples = [
    'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
    'sk-proj-AbCdEfGhIjKlMnOpQrSt',
    'ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123',
    'github_pat_11ABCDEFG0123456789_abcdefghij',
    'xoxb-1234567890-abcdefghij',
    'AKIAIOSFODNN7EXAMPLE',
    'AIzaSyA-1234567890abcdefghijklmnopqrstu',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
  ];
  for (const s of samples) assert.equal(redact(`key: ${s} end`), `key: ${REDACTED} end`, s);
  const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nabc\n-----END RSA PRIVATE KEY-----';
  assert.equal(redact(`a\n${pem}\nb`), `a\n${REDACTED}\nb`);
});

test('이름이 비밀값인 설정은 값만, Bearer는 토큰만 가린다', () => {
  assert.equal(redact('OPENAI_API_KEY=abc123def456ghi'), `OPENAI_API_KEY=${REDACTED}`);
  assert.equal(redact('"password": "hunter2hunter2"'), `"password": "${REDACTED}"`);
  assert.equal(redact('DB_PASSWORD: s3cretValue!'), `DB_PASSWORD: ${REDACTED}`);
  assert.equal(redact('Authorization: Bearer abcdefghijklmnop123456'), `Authorization: Bearer ${REDACTED}`);
});

test('일반 값은 그대로: git SHA, 토큰 수, 짧은 값, 설명 문장', () => {
  const keep = [
    'commit 96da30026b65a40a748d44483ce1dd87f52c2ccf',
    '"total_tokens": 123456789',
    '"output_tokens": 4096, "input_tokens": 12000',
    'token=12345678', // 숫자만
    'password: short',
    'Set your API key in the settings page.',
    'npm run test -- --grep token',
  ];
  for (const s of keep) assert.equal(redact(s), s, s);
});

test('정확히 아는 비밀값(데몬 접속 토큰)은 어떤 모양이든 가린다, 구조가 있는 값은 안쪽 문자열까지', () => {
  const token = 'Qx9_kq2-pLm7vB3nR8tW';
  assert.equal(redact(`url http://127.0.0.1:4777/#token=${token}`, [token]), `url http://127.0.0.1:4777/#token=${REDACTED}`);
  const out = redactDeep({ items: [{ text: 'ok', detail: `export GH=ghp_${'a'.repeat(30)}` }], n: 3, none: null });
  assert.deepEqual(out, { items: [{ text: 'ok', detail: `export GH=${REDACTED}` }], n: 3, none: null });
});
