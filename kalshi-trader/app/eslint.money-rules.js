// @ts-check
/**
 * Money-path lint rules (SPEC.md "Conventions used everywhere"): Kalshi `*_dollars`
 * (and `*_fp`) strings must go through `core/decimal.ts`, never through floating point.
 * Tested by `test/security/money-lint.test.ts`.
 */
const FIELD = '/_(dollars|fp)$/';
const MESSAGE =
  'Do not convert Kalshi *_dollars / *_fp values with floating point; use the exact converters in core/decimal.ts.';

/** Selectors for `fn(<field>)` where the argument is `x.foo_dollars`, `x['foo_dollars']` or `foo_dollars`. */
function callOn(fn) {
  return [
    `CallExpression[callee.name='${fn}'] > MemberExpression.arguments[property.name=${FIELD}]`,
    `CallExpression[callee.name='${fn}'] > MemberExpression.arguments[property.value=${FIELD}]`,
    `CallExpression[callee.name='${fn}'] > Identifier.arguments[name=${FIELD}]`,
    `CallExpression[callee.object.name='Number'][callee.property.name='${fn}'] > MemberExpression.arguments[property.name=${FIELD}]`,
    `CallExpression[callee.object.name='Number'][callee.property.name='${fn}'] > Identifier.arguments[name=${FIELD}]`,
  ];
}

const selectors = [
  ...callOn('parseFloat'),
  ...callOn('Number'),
  `UnaryExpression[operator='+'] > MemberExpression.argument[property.name=${FIELD}]`,
  `UnaryExpression[operator='+'] > Identifier.argument[name=${FIELD}]`,
];

export const moneyRules = {
  'no-restricted-syntax': ['error', ...selectors.map((selector) => ({ selector, message: MESSAGE }))],
};
