import { it, expect } from 'vitest';
import { parseId, serializeId, actionSchema } from './index';
it('preserves u64 IDs beyond number precision', () => {
  const n = 18446744073709551615n;
  expect(parseId(serializeId(n))).toBe(n);
  expect(() => parseId('18446744073709551616')).toThrow();
  expect(() => parseId('1e3')).toThrow();
});
it('rejects declarations of success and unknown fields', () => {
  expect(() =>
    actionSchema.parse({ type: 'complete', taskId: '1', attempt: 1 }),
  ).toThrow();
  expect(() =>
    actionSchema.parse({
      type: 'start_operation',
      taskId: '1',
      attempt: 1,
      success: true,
    }),
  ).toThrow();
});
