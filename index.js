// QuantEdge AI v2 — Server Brain
// Node.js — runs on DigitalOcean permanently via PM2
// All trading logic lives here. Browser is display only.

const http  = require('http');
const https = require('https');
const url   = require('url');
const fs    = require('fs');

// ═══════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════
let state = {
  token:           null,
  capital:         0,
  isRunning:       false,
  positions:       [],      // open positions
  trades:          [],      // closed trades today
  dailyPnl:        0,
  logs:            [],
  niftySpot:       0,
  vwap:            0,
  niftyOpen:       0,
  pdHigh:          0,
  pdLow:           0,
  candles:         [],      // last 20 x 15min candles
  lastSignalTime:  {},      // key -> timestamp (dedup)
  lossStreak:      {},      // direction -> count
  sseClients:      [],
  scanTimer:       null,
  posTimer:        null,
  eodFired:        false,
};

// ═══════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════
function log(level, msg) {
  const entry = { time: new Date().toLocaleTimeString('en-IN'), level, msg };
  state.logs.unshift(entry);
  if (state.logs.length > 100) state.logs = state.logs.slice(0, 100);
  console.log('[' + level + '] ' + msg);
  broadcast({ type: 'LOG', entry });
}

// ═══════════════════════════════════════════════
// UPSTOX API
// ═══════════════════════════════════════════════
function upstox(method, path, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.upstox.com',
      path,
      method,
      headers: {
        'Authorization': 'Bearer ' + state.token,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { resolve({}); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ═══════════════════════════════════════════════
// MARKET DATA
// ═══════════════════════════════════════════════
async function fetchMarketData() {
  try {
    // NIFTY spot + OHLC
    const q = await upstox('GET', '/v2/market-quote/quotes?instrument_key=NSE_INDEX%7CNifty%2050');
    const _qdata = q?.data || {};const d = _qdata['NSE_INDEX|Nifty 50'] || _qdata[Object.keys(_qdata)[0]];
    if (d) {
      state.niftySpot = d.last_price || 0;
      state.niftyOpen = d.ohlc?.open || state.niftyOpen;
      state.pdHigh    = d.ohlc?.close || state.pdHigh; // previous day from history
    }

    // 15-min candles for VWAP + EMA + ATR + RSI
    const now   = new Date();
    const today = now.toISOString().slice(0, 10);
    const cResp = await upstox('GET',
      '/v2/historical-candle/intraday/NSE_INDEX%7CNifty%2050/15minute');
    const candles = cResp?.data?.candles || [];
    // Each candle: [timestamp, open, high, low, close, volume, oi]
    state.candles = candles.slice(-20);

    // VWAP from today's candles
    if (state.candles.length > 0) {
      let cumVol = 0, cumPV = 0;
      for (const c of state.candles) {
        const tp  = (c[2] + c[3] + c[4]) / 3; // typical price
        const vol = c[5] || 1;
        cumPV  += tp * vol;
        cumVol += vol;
      }
      state.vwap = cumVol > 0 ? Math.round(cumPV / cumVol) : state.niftySpot;
    }

    // Previous day high/low from daily candle
    const daily = await upstox('GET',
      '/v2/historical-candle/NSE_INDEX%7CNifty%2050/day/2?api_version=2.0');
    const dCandles = daily?.data?.candles || [];
    if (dCandles.length >= 2) {
      const prev = dCandles[dCandles.length - 2];
      state.pdHigh = prev[2];
      state.pdLow  = prev[3];
    }

  } catch(e) {
    log('ERROR', 'fetchMarketData: ' + e.message);
  }
}

// ═══════════════════════════════════════════════
// SIGNAL ENGINE
// ═══════════════════════════════════════════════
function calcEMA(closes, period) {
  if (closes.length < period) return 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return 100 - (100 / (1 + rs));
}

function calcATR(candles, period = 5) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const high  = candles[i][2];
    const low   = candles[i][3];
    const pClose = candles[i-1][4];
    trs.push(Math.max(high - low, Math.abs(high - pClose), Math.abs(low - pClose)));
  }
  const recent = trs.slice(-period);
  return recent.reduce((a,b) => a+b, 0) / recent.length;
}

function calcBB(closes, period = 20) {
  if (closes.length < period) return { upper: 0, lower: 0, mid: 0 };
  const slice = closes.slice(-period);
  const mid   = slice.reduce((a,b) => a+b, 0) / period;
  const std   = Math.sqrt(slice.reduce((a,b) => a + (b-mid)**2, 0) / period);
  return { upper: mid + 2*std, lower: mid - 2*std, mid };
}

function generateSignal() {
  const spot     = state.niftySpot;
  const vwap     = state.vwap;
  const open     = state.niftyOpen;
  const pdHigh   = state.pdHigh;
  const pdLow    = state.pdLow;
  const candles  = state.candles;

  if (!spot || !vwap || candles.length < 5) return null;

  const closes = candles.map(c => c[4]);
  const highs  = candles.map(c => c[2]);
  const lows   = candles.map(c => c[3]);

  const ema9  = calcEMA(closes, 9);
  const ema21 = calcEMA(closes, 21);
  const rsi   = calcRSI(closes);
  const atr   = calcATR(candles, 5);
  const bb    = calcBB(closes);

  // TIME FILTERS
  const now  = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins < 565) return null;  // before 9:45 AM
  if (mins > 840) return null;  // after 2:00 PM

  // FILTER 2: Choppy day — ATR too low
  if (atr < 15) {
    return null;  // market is choppy, no trade
  }

  // Start scoring
  let ceScore = 0, peScore = 0;
  const reasons = [];

  // FILTER 1: VWAP (mandatory, +20)
  if (spot > vwap * 1.001) {
    ceScore += 20;
    reasons.push('Above VWAP');
  } else if (spot < vwap * 0.999) {
    peScore += 20;
    reasons.push('Below VWAP');
  } else {
    return null; // too close to VWAP
  }

  // EMA crossover (+20)
  if (ema9 > ema21) {
    ceScore += 20;
    reasons.push('EMA bullish');
  } else {
    peScore += 20;
    reasons.push('EMA bearish');
  }

  // Day open bias (+15)
  if (spot > open) {
    ceScore += 15;
    reasons.push('Above open');
  } else {
    peScore += 15;
    reasons.push('Below open');
  }

  // RSI (+10)
  if (rsi < 35) {
    ceScore += 10;
    reasons.push('RSI oversold');
  } else if (rsi > 65) {
    peScore += 10;
    reasons.push('RSI overbought');
  }

  // PDH/PDL breakout (+15)
  if (pdHigh > 0 && spot > pdHigh * 1.001) {
    ceScore += 15;
    reasons.push('Above PDH');
  } else if (pdLow > 0 && spot < pdLow * 0.999) {
    peScore += 15;
    reasons.push('Below PDL');
  }

  // Bollinger Bands (+10)
  if (bb.lower > 0 && spot < bb.lower * 1.002) {
    ceScore += 10;
    reasons.push('Near BB lower');
  } else if (bb.upper > 0 && spot > bb.upper * 0.998) {
    peScore += 10;
    reasons.push('Near BB upper');
  }

  // FILTER 3: Momentum — last 3 candles same direction
  const last3 = candles.slice(-3);
  const ceCandles = last3.filter(c => c[4] > c[1]).length; // close > open
  const peCandles = last3.filter(c => c[4] < c[1]).length;

  // FILTER 4: Resistance/Support penalty
  const nearResistance = pdHigh > 0 && Math.abs(spot - pdHigh) / spot < 0.003;
  const nearSupport    = pdLow > 0 && Math.abs(spot - pdLow) / spot < 0.003;
  // Penalise round numbers too (24000, 24200, 24400 etc)
  const nearRound = Math.round(spot / 200) * 200;
  const atRound   = Math.abs(spot - nearRound) / spot < 0.003;

  let direction, score;
  if (ceScore > peScore) {
    if (ceCandles < 2) return null;          // Filter 3: need momentum
    if (nearResistance || atRound) ceScore -= 20;  // Filter 4: resistance penalty
    direction = 'CE';
    score     = ceScore;
  } else {
    if (peCandles < 2) return null;          // Filter 3
    if (nearSupport || atRound) peScore -= 20;     // Filter 4
    direction = 'PE';
    score     = peScore;
  }

  if (score < 85) return null;

  // Cooldowns
  const dedupKey  = 'NIFTY-' + direction;
  const lastSig   = state.lastSignalTime[dedupKey] || 0;
  if (Date.now() - lastSig < 90000) return null;  // 90s dedup

  const lossCool  = state.lossStreak[direction] || 0;
  if (lossCool >= 2) return null; // 2 losses same direction = stop

  // Strike selection — one step OTM
  const step   = 50;
  let strike;
  if (direction === 'CE') {
    strike = Math.ceil(spot / step) * step;
  } else {
    strike = Math.floor(spot / step) * step;
  }

  return { instrument: 'NIFTY', strike, direction, score: Math.min(score, 97), reasons, spot };
}

// ═══════════════════════════════════════════════
// ORDER FUNCTIONS
// ═══════════════════════════════════════════════
async function getOptionKey(strike, direction, expiryDate) {
  try {
    const resp = await upstox('GET',
      '/v2/option/contract?instrument_key=NSE_INDEX%7CNifty%2050&expiry_date=' + expiryDate);
    const contracts = resp?.data || [];
    const match = contracts.find(c =>
      Number(c.strike_price) === strike &&
      c.instrument_type === direction
    );
    return match || null;
  } catch(e) { return null; }
}

async function getLiveLtp(instrumentKey) {
  try {
    const encoded = encodeURIComponent(instrumentKey);
    const resp = await upstox('GET', '/v2/market-quote/ltp?instrument_key=' + encoded);
    const d = resp?.data;
    if (!d) return 0;
    return d[instrumentKey]?.last_price || Object.values(d)[0]?.last_price || 0;
  } catch(e) { return 0; }
}

async function getNextExpiry() {
  const now   = new Date();
  // Find next Thursday
  let d = new Date(now);
  d.setHours(0,0,0,0);
  while (d.getDay() !== 4) d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function placeOrder(instrumentKey, side, qty) {
  const resp = await upstox('POST', '/v2/order/place', {
    quantity:           qty,
    product:            'I',
    validity:           'DAY',
    price:              0,
    tag:                'qe2',
    instrument_token:   instrumentKey,
    order_type:         'MARKET',
    transaction_type:   side,
    disclosed_quantity: 0,
    trigger_price:      0,
    is_amo:             false,
  });
  return resp;
}

async function getOrderStatus(orderId) {
  try {
    const resp = await upstox('GET', '/v2/order/details?order_id=' + orderId);
    return resp?.data || null;
  } catch(e) { return null; }
}

async function getPositions() {
  try {
    const resp = await upstox('GET', '/v2/portfolio/short-term-positions');
    return resp?.data || [];
  } catch(e) { return []; }
}

async function getRealBalance() {
  try {
    const resp = await upstox('GET', '/v2/user/fund-margin');
    return resp?.data?.equity?.available_margin || 0;
  } catch(e) { return 0; }
}

// ═══════════════════════════════════════════════
// ENTRY FLOW
// ═══════════════════════════════════════════════
async function enterTrade(signal) {
  if (state.positions.length >= 1) return; // max 1 position

  const expiry = await getNextExpiry();
  log('INFO', 'SIGNAL: NIFTY ' + signal.strike + ' ' + signal.direction +
    ' | ' + signal.score + '% | ' + signal.reasons.join(', ') +
    ' | VWAP ₹' + state.vwap);

  // Find contract
  const match = await getOptionKey(signal.strike, signal.direction, expiry);
  if (!match) {
    log('WARN', 'No contract found for NIFTY ' + signal.strike + ' ' + signal.direction);
    return;
  }

  // Get live price
  let livePrice = match.last_price || 0;
  if (!livePrice || livePrice === 0) {
    livePrice = await getLiveLtp(match.instrument_key);
  }
  if (!livePrice || livePrice === 0) {
    log('WARN', '🚫 NO MARKET PRICE: NIFTY ' + signal.strike + ' ' + signal.direction);
    return;
  }
  if (livePrice < 10) {
    log('WARN', '🚫 WORTHLESS OPTION: ₹' + livePrice + ' — skipping');
    return;
  }

  // Update dedup timestamp
  state.lastSignalTime['NIFTY-' + signal.direction] = Date.now();

  // Place order
  log('INFO', '⏳ Placing BUY: NIFTY ' + signal.strike + ' ' + signal.direction + ' x65 MARKET');
  const qty = 65;
  let orderResp;
  try {
    orderResp = await placeOrder(match.instrument_key, 'BUY', qty);
  } catch(e) {
    log('ERROR', 'BUY failed: ' + e.message);
    return;
  }

  if (orderResp?.status !== 'success') {
    log('ERROR', '❌ BUY rejected: ' + JSON.stringify(orderResp?.errors || orderResp?.message));
    return;
  }

  const orderId = orderResp.data?.order_id;
  log('INFO', '✅ BUY placed: Order ' + orderId);

  // Wait for fill
  await new Promise(r => setTimeout(r, 3500));
  const fillData = await getOrderStatus(orderId);
  const avgPrice = fillData?.average_price || livePrice;
  const realKey  = fillData?.instrument_token || match.instrument_key;

  log('INFO', '✅ FILL CONFIRMED: NIFTY ' + signal.strike + ' ' + signal.direction +
    ' @ ₹' + avgPrice + ' (estimated ₹' + livePrice + ')');

  // Post-fill gap check
  if (avgPrice > livePrice * 1.5) {
    log('WARN', '🚫 POST-FILL GAP: filled ₹' + avgPrice + ' vs estimate ₹' + livePrice + ' — closing');
    try {
      await placeOrder(realKey, 'SELL', qty);
    } catch(e) {}
    return;
  }

  // Store position
  const pos = {
    id:            Date.now().toString(),
    instrument:    'NIFTY',
    strike:        signal.strike,
    direction:     signal.direction,
    entryPrice:    avgPrice,
    currentPrice:  avgPrice,
    unrealPnl:     0,
    sl:            Math.round(avgPrice * 0.82),
    target:        Math.round(avgPrice * 1.40),
    trailLocked:   false,
    qty,
    orderId,
    instrumentKey: realKey,
    expiry,
    entryTime:     new Date().toISOString(),
  };

  state.positions.push(pos);
  broadcast({ type: 'STATE_UPDATE', state: getSafeState() });
  log('INFO', '📊 Position open: entry ₹' + avgPrice + ' SL ₹' + pos.sl + ' Target ₹' + pos.target);
}

// ═══════════════════════════════════════════════
// EXIT FLOW
// ═══════════════════════════════════════════════
async function exitPosition(pos, reason) {
  log('INFO', '⏳ Closing: NIFTY ' + pos.strike + ' ' + pos.direction + ' [' + reason + ']');

  let orderResp;
  try {
    orderResp = await placeOrder(pos.instrumentKey, 'SELL', pos.qty);
  } catch(e) {
    log('ERROR', 'SELL failed: ' + e.message);
    return;
  }

  if (orderResp?.status !== 'success') {
    // Retry LIMIT
    const limitPx = Math.floor((pos.currentPrice || pos.entryPrice) * 0.97);
    log('WARN', '⚠️ MARKET SELL failed, retrying LIMIT @ ₹' + limitPx);
    try {
      await upstox('POST', '/v2/order/place', {
        quantity: pos.qty, product: 'I', validity: 'DAY',
        price: limitPx, tag: 'qe2', instrument_token: pos.instrumentKey,
        order_type: 'LIMIT', transaction_type: 'SELL',
        disclosed_quantity: 0, trigger_price: 0, is_amo: false,
      });
    } catch(e) {}
  }

  const sellOrderId = orderResp?.data?.order_id;
  await new Promise(r => setTimeout(r, 3500));

  let exitPrice = pos.currentPrice || pos.entryPrice;
  if (sellOrderId) {
    const fillData = await getOrderStatus(sellOrderId);
    if (fillData?.average_price > 0) exitPrice = fillData.average_price;
  }

  // Record trade
  const rawPnl  = Math.round((exitPrice - pos.entryPrice) * pos.qty);
  const fees    = Math.round(48 + exitPrice * pos.qty * 0.0005 + (pos.entryPrice + exitPrice) * pos.qty * 0.00053);
  const netPnl  = rawPnl - fees;

  state.dailyPnl += netPnl;
  state.positions = state.positions.filter(p => p.id !== pos.id);
  state.trades.push({
    instrument: pos.instrument,
    strike:     pos.strike,
    direction:  pos.direction,
    entryPrice: pos.entryPrice,
    exitPrice,
    pnl:        netPnl,
    reason,
    time:       new Date().toISOString(),
  });

  // Loss streak tracking
  if (netPnl < 0) {
    state.lossStreak[pos.direction] = (state.lossStreak[pos.direction] || 0) + 1;
  } else {
    state.lossStreak[pos.direction] = 0;
  }

  const mark = netPnl >= 0 ? '✅' : '❌';
  log('INFO', mark + ' CLOSED [' + reason + ']: NIFTY ' + pos.strike + ' ' + pos.direction +
    ' entry ₹' + pos.entryPrice + ' exit ₹' + exitPrice + ' = ₹' + netPnl);
  log('INFO', '💰 Daily P&L: ₹' + state.dailyPnl);

  broadcast({ type: 'STATE_UPDATE', state: getSafeState() });
}

// ═══════════════════════════════════════════════
// POSITION MONITOR (every 10 seconds)
// ═══════════════════════════════════════════════
async function monitorPositions() {
  if (state.positions.length === 0) return;

  // EOD check
  const now  = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  if (mins >= 910 && !state.eodFired) {
    state.eodFired = true;
    log('INFO', '🕐 EOD: Auto-closing all positions at 15:10');
    for (const pos of [...state.positions]) {
      await exitPosition(pos, 'EOD');
    }
    return;
  }

  // Fetch real prices from positions API
  const upstoxPositions = await getPositions();

  for (const pos of [...state.positions]) {
    // Match by trading symbol
    const sym     = (pos.instrument + pos.strike + pos.direction).toUpperCase();
    const matched = upstoxPositions.find(p =>
      (p.trading_symbol || '').toUpperCase().includes(sym)
    );
    const ltp = matched?.last_price || 0;
    if (ltp <= 0) continue;

    // Update current price
    pos.currentPrice = ltp;
    pos.unrealPnl    = Math.round((ltp - pos.entryPrice) * pos.qty);

    // SL check
    if (ltp <= pos.sl) {
      log('WARN', '🛑 SL HIT: NIFTY ' + pos.strike + ' ' + pos.direction +
        ' LTP ₹' + ltp + ' ≤ SL ₹' + pos.sl);
      await exitPosition(pos, 'SL HIT');
      continue;
    }

    // Target check (backup — primary is the limit order)
    if (ltp >= pos.target) {
      log('INFO', '🎯 TARGET HIT: NIFTY ' + pos.strike + ' ' + pos.direction +
        ' LTP ₹' + ltp + ' ≥ Target ₹' + pos.target);
      await exitPosition(pos, 'TARGET HIT');
      continue;
    }

    // Trail: move SL to break-even at +20%
    const gain = (ltp - pos.entryPrice) / pos.entryPrice;
    if (!pos.trailLocked && gain >= 0.20) {
      pos.sl         = pos.entryPrice;
      pos.trailLocked = true;
      log('INFO', '✅ TRAIL: SL moved to break-even ₹' + pos.sl +
        ' (gain ' + Math.round(gain * 100) + '%)');
    }

    broadcast({ type: 'POSITION_UPDATE', positions: state.positions });
  }
}

// ═══════════════════════════════════════════════
// MAIN SCAN LOOP (every 60 seconds)
// ═══════════════════════════════════════════════
async function scan() {
  if (!state.isRunning || !state.token) return;
  try {
    await fetchMarketData();
    broadcast({ type: 'MARKET', spot: state.niftySpot, vwap: state.vwap });

    if (state.positions.length === 0) {
      const signal = generateSignal();
      if (signal) {
        await enterTrade(signal);
      }
    }
  } catch(e) {
    log('ERROR', 'Scan error: ' + e.message);
  }
}

// ═══════════════════════════════════════════════
// SSE BROADCAST
// ═══════════════════════════════════════════════
function broadcast(data) {
  const msg = 'data: ' + JSON.stringify(data) + '\n\n';
  state.sseClients = state.sseClients.filter(res => {
    try { res.write(msg); return true; }
    catch(e) { return false; }
  });
}

function getSafeState() {
  return {
    isRunning:  state.isRunning,
    positions:  state.positions,
    trades:     state.trades,
    dailyPnl:   state.dailyPnl,
    logs:       state.logs.slice(0, 20),
    niftySpot:  state.niftySpot,
    vwap:       state.vwap,
    capital:    state.capital,
  };
}

// ═══════════════════════════════════════════════
// HTTP SERVER
// ═══════════════════════════════════════════════
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path   = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  // SSE stream
  if (path === '/stream') {
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    });
    res.write('data: ' + JSON.stringify({ type: 'STATE_UPDATE', state: getSafeState() }) + '\n\n');
    state.sseClients.push(res);
    req.on('close', () => {
      state.sseClients = state.sseClients.filter(c => c !== res);
    });
    return;
  }

  // Serve index.html
  if (path === '/' || path === '/index.html') {
    try {
      const html = fs.readFileSync(__dirname + '/index.html');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
    } catch(e) {
      res.writeHead(404); res.end('index.html not found');
    }
    return;
  }

  // Parse body
  let body = '';
  await new Promise(r => { req.on('data', c => body += c); req.on('end', r); });
  let data = {};
  try { data = JSON.parse(body); } catch(e) {}

  // POST /connect
  if (path === '/connect' && req.method === 'POST') {
    state.token      = data.token;
    state.capital    = data.capital || 0;
    state.dailyPnl   = 0;
    state.trades     = [];
    state.positions  = [];
    state.eodFired   = false;
    state.lossStreak = {};
    await fetchMarketData();
    const balance = await getRealBalance();
    if (balance > 0) {
      state.capital = balance;
      log('INFO', '💰 Real balance from Upstox: ₹' + balance);
    } else {
      log('WARN', '⚠️ Could not fetch balance — using entered capital ₹' + state.capital);
    }
    log('INFO', '✅ Connected | NIFTY ₹' + state.niftySpot + ' | VWAP ₹' + state.vwap + ' | Capital ₹' + state.capital);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, capital: state.capital, nifty: state.niftySpot }));
    return;
  }

  // POST /start
  if (path === '/start' && req.method === 'POST') {
    if (!state.token) { res.writeHead(400); res.end(JSON.stringify({ error: 'Not connected' })); return; }
    state.isRunning = true;
    if (state.scanTimer) clearInterval(state.scanTimer);
    if (state.posTimer)  clearInterval(state.posTimer);
    state.scanTimer = setInterval(scan, 60000);
    state.posTimer  = setInterval(monitorPositions, 10000);
    scan(); // run immediately
    log('INFO', '🟢 Auto-trading STARTED');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /stop
  if (path === '/stop' && req.method === 'POST') {
    state.isRunning = false;
    if (state.scanTimer) { clearInterval(state.scanTimer); state.scanTimer = null; }
    if (state.posTimer)  { clearInterval(state.posTimer);  state.posTimer  = null; }
    log('INFO', '🔴 Auto-trading STOPPED');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // POST /close/:id
  if (path.startsWith('/close/') && req.method === 'POST') {
    const posId = path.split('/close/')[1];
    const pos   = state.positions.find(p => p.id === posId);
    if (!pos) { res.writeHead(404); res.end(JSON.stringify({ error: 'Position not found' })); return; }
    await exitPosition(pos, 'MANUAL');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // GET /state
  if (path === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getSafeState()));
    return;
  }

  res.writeHead(404); res.end('Not found');
});

server.listen(3000, () => {
  console.log('QuantEdge v2 running on port 3000');
});
