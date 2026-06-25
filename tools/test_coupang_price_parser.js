function priceNumber(text) {
  var m = String(text || '').replace(/,/g, '').match(/(\d{3,})/);
  return m ? Number(m[1]) : null;
}

function parseCurrentPriceFromText(text) {
  function addLineCandidate(list, value, score, order, originalIndex) {
    if (value === null) return;
    list.push({ value: value, score: score, order: order, originalIndex: originalIndex || 0 });
  }

  var lines = text.split(/\n+/).map(function(line) { return line.trim(); }).filter(Boolean);
  function priceValuesFromLine(line) {
    return (String(line || '').match(/[\d,]{3,}\s*원/g) || [])
      .map(function(match) { return priceNumber(match); })
      .filter(function(value) { return value !== null; });
  }

  var lineCandidates = [];
  lines.forEach(function(line, index) {
    if (/최대|적립|도착|배송|무료배송|로켓|리뷰|상품평|모레|내일|오늘/i.test(line)) return;
    var matches = line.match(/[\d,]{3,}\s*원/g) || [];
    if (!matches.length) return;
    var score = 10;
    var hasPercent = /%/.test(line);
    if (hasPercent && matches.length > 1) score += 45;
    if (/판매가|쿠폰|와우|즉시|할인가|최종|타임할인/i.test(line)) score += 35;
    if (/정가|할인\s*$/i.test(line)) score -= 45;
    if (/개당/i.test(line)) score -= 25;
    var values = matches.map(function(match) { return priceNumber(match); }).filter(function(value) { return value !== null; });
    if (!values.length) return;
    if (hasPercent && values.length > 1) {
      addLineCandidate(lineCandidates, Math.min.apply(Math, values), score + 15, index, 0);
      return;
    }
    if (hasPercent && values.length === 1) {
      var currentValue = values[0];
      var prevValues = priceValuesFromLine(lines[index - 1] || '');
      var nextValues = priceValuesFromLine(lines[index + 1] || '');
      var prevHigher = prevValues.some(function(value) { return value > currentValue; });
      var nextLower = nextValues.some(function(value) { return value < currentValue; });
      if (nextLower) score -= 70;
      else if (prevHigher) score += 75;
      else score += 15;
    }
    values.forEach(function(value, matchIndex) {
      addLineCandidate(lineCandidates, value, score + matchIndex, index, matchIndex);
    });
  });
  lineCandidates.sort(function(a, b) {
    if (b.score !== a.score) return b.score - a.score;
    if (b.order !== a.order) return b.order - a.order;
    return a.value - b.value;
  });
  return lineCandidates[0] && lineCandidates[0].value;
}

var cases = [
  { name: 'discount-old-next-sale', text: '51% 38,900원\n18,900원\n내일 도착', expected: 18900 },
  { name: 'old-prev-discount-sale', text: '64,900원\n33% 43,340원\n판매자로켓', expected: 43340 },
  { name: 'same-line-two-prices', text: '39% 42,900원 25,900원\n로켓', expected: 25900 },
  { name: 'plain-sale', text: '25,900원\n무료배송', expected: 25900 },
  { name: 'unit-price-ignored', text: '20,970원\n(1개당 20,970원)\n최대 17,000원', expected: 20970 }
];

var results = cases.map(function(c) {
  return { name: c.name, got: parseCurrentPriceFromText(c.text), expected: c.expected };
});
var failed = results.filter(function(result) { return result.got !== result.expected; });
if (failed.length) {
  console.error(JSON.stringify(results, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(results));
