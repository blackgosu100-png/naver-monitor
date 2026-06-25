const fs = require('fs');
const vm = require('vm');

const source = fs.readFileSync('chrome_extension/background.js', 'utf8');
const addStart = source.indexOf('function addCoupangProductMetricOptions');
const numStart = source.lastIndexOf('function numOrNull(value)', addStart);
if (numStart < 0 || addStart < 0 || addStart <= numStart) {
  throw new Error('Could not locate Coupang guard helpers');
}

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(source.slice(numStart, addStart), sandbox);

const cases = [
  [null, { total: null, lowerBound: false }],
  ['', { total: null, lowerBound: false }],
  [123, { total: 123, lowerBound: false }],
  ['1,234', { total: 1234, lowerBound: false }],
  [{ total: '2,345', lowerBound: true }, { total: 2345, lowerBound: true }],
  [{ total: null, lowerBound: true }, { total: null, lowerBound: true }],
  [[{ total: 999 }], { total: null, lowerBound: false }]
];

for (const [input, expected] of cases) {
  const actual = sandbox.normalizeCoupangPublicMonthly(input);
  if (actual.total !== expected.total || actual.lowerBound !== expected.lowerBound) {
    throw new Error(`normalize mismatch for ${JSON.stringify(input)}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
  }
}

console.log('coupang overlay metric guards ok');
