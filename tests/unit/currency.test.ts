import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOrder, validateConfirmation } from '../../src/integrations/alveron/schemas.js';

test('a non-NGN order cannot be rendered as an NGN confirmation', () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const order = parseOrder({ id, order_number: 1, status: 'paid', payment_status: 'SUCCESS',
    customer_email: 'synthetic@example.invalid', currency: 'USD',
    subtotal: 100, discount: 0, shipping: 0, total: 100,
    items: [{ title: 'Synthetic fixture', quantity: 1, price: 100 }], payments: [] });
  assert.throws(() => validateConfirmation(order, id), { message: 'VALIDATION_FAILED' });
});
