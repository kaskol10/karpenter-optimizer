import { describe, test, expect } from 'vitest';
import { formatCurrency } from './currency';

describe('formatCurrency', () => {
  test.each(['cn-north-1', 'cn-northwest-1'])(
    'formats %s values as Chinese yuan',
    (region) => {
      expect(formatCurrency(12.5, region)).toBe('CN¥12.50');
    },
  );

  test.each(['us-east-1', 'eu-west-1', ''])(
    'formats %s values as dollars',
    (region) => {
      expect(formatCurrency(12.5, region)).toBe('$12.50');
    },
  );
});