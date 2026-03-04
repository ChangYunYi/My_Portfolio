function RSI(ticker, period, days) {
  if (!period) period = 14;
  if (!days) days = 60;

  var endDate = new Date();
  var startDate = new Date();
  startDate.setDate(endDate.getDate() - days);

  var p1 = Math.floor(startDate / 1000);
  var p2 = Math.floor(endDate / 1000);
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1d&period1=' + p1 + '&period2=' + p2;

  try {
    var response = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    var data = JSON.parse(response.getContentText());
    var rawCloses = data.chart.result[0].indicators.quote[0].close;
    var closes = [];
    for (var n = 0; n < rawCloses.length; n++) {
      if (rawCloses[n] !== null) closes.push(rawCloses[n]);
    }

    if (closes.length < period + 1) return '데이터 부족';

    var changes = [];
    for (var i = 1; i < closes.length; i++) {
      changes.push(closes[i] - closes[i-1]);
    }

    var avgGain = 0;
    var avgLoss = 0;
    for (var j = 0; j < period; j++) {
      if (changes[j] > 0) avgGain += changes[j];
      else avgLoss += Math.abs(changes[j]);
    }
    avgGain = avgGain / period;
    avgLoss = avgLoss / period;

    for (var k = period; k < changes.length; k++) {
      var g = changes[k] > 0 ? changes[k] : 0;
      var l = changes[k] < 0 ? Math.abs(changes[k]) : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
    }

    if (avgLoss === 0) return 100;
    var rs = avgGain / avgLoss;
    return Math.round((100 - (100 / (1 + rs))) * 100) / 100;

  } catch(e) {
    return 'Error: ' + e.message;
  }
}


function PRICE_STATS(ticker, period, multiplier) {
  if (!period) period = 20;
  if (!multiplier) multiplier = 2;

  // 데이터 조회 기간을 period의 1.5배로 자동 설정 (여유분 확보)
  var fetchDays = Math.ceil(period * 1.5) + 30;

  var endDate = new Date();
  var startDate = new Date();
  startDate.setDate(endDate.getDate() - fetchDays);

  var p1 = Math.floor(startDate / 1000);
  var p2 = Math.floor(endDate / 1000);
  var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1d&period1=' + p1 + '&period2=' + p2;

  try {
    var response = UrlFetchApp.fetch(url, {muteHttpExceptions: true});
    var data = JSON.parse(response.getContentText());
    var rawCloses = data.chart.result[0].indicators.quote[0].close;

    var closes = [];
    for (var n = 0; n < rawCloses.length; n++) {
      if (rawCloses[n] !== null) closes.push(rawCloses[n]);
    }

    if (closes.length < period) return '데이터 부족';

    var recent = closes.slice(-period);
    var currentPrice = closes[closes.length - 1];

    var sum = 0;
    for (var i = 0; i < recent.length; i++) sum += recent[i];
    var mean = sum / recent.length;

    var variance = 0;
    for (var j = 0; j < recent.length; j++) {
      variance += Math.pow(recent[j] - mean, 2);
    }
    var stdDev = Math.sqrt(variance / recent.length);

    var upperBand = mean + (stdDev * multiplier);
    var lowerBand = mean - (stdDev * multiplier);
    var position = Math.round(((currentPrice - lowerBand) / (upperBand - lowerBand)) * 100);

    var signal = '';
    if (currentPrice < lowerBand) signal = '강매수';
    else if (currentPrice < mean - stdDev) signal = '매수검토';
    else if (currentPrice > upperBand) signal = '강매도';
    else if (currentPrice > mean + stdDev) signal = '매도검토';
    else signal = '중립';

    return [[
      '현재가', '평균', '표준편차', '하단밴드(-2σ)', '상단밴드(+2σ)', '밴드위치(%)', '신호'
    ],[
      Math.round(currentPrice * 100) / 100,
      Math.round(mean * 100) / 100,
      Math.round(stdDev * 100) / 100,
      Math.round(lowerBand * 100) / 100,
      Math.round(upperBand * 100) / 100,
      position,
      signal
    ]];

  } catch(e) {
    return 'Error: ' + e.message;
  }
}