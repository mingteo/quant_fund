require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const targetCoins = [
  "BTCUSDT",
  "ETHUSDT",
  "SOLUSDT",
  "SUIUSDT",
  "BNBUSDT",
  "XRPUSDT",
  "DOGEUSDT",
  "AVAXUSDT",
  "LINKUSDT",
  "HYPEUSDT",
  "ZECUSDT",
  "PAXGUSDT",
];

// --- 1. MATEMATIKA ---
function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return ema;
}
function calculateSMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function calculateROC(prices, period) {
  if (prices.length <= period) return 0;
  const current = prices[prices.length - 1];
  const past = prices[prices.length - 1 - period];
  return ((current - past) / past) * 100;
}

// --- 2. TELEGRAM BROADCAST ---
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: text,
      parse_mode: "Markdown",
    }),
  });
}

async function broadcastUpdate(regimeStatus, totalEquity, newCapitalUSDT) {
  const { data: history } = await supabase
    .from("portfolio_history")
    .select("*")
    .order("date", { ascending: false })
    .limit(1);
  const { data: positions } = await supabase
    .from("current_positions")
    .select("*")
    .order("percentage", { ascending: false });

  if (!history || history.length === 0) return;
  const last = history[0];

  let cryptoExposurePct = 0;
  let hasCrypto = false;
  let activePositionsText = "";

  positions.forEach((p) => {
    if (p.symbol === "USDT") return;
    hasCrypto = true;
    cryptoExposurePct += parseFloat(p.percentage);
    const isWhaleTarget = parseFloat(p.percentage) > 20 ? "🐋" : "⚡";
    activePositionsText += `${isWhaleTarget} *${p.symbol}*: ${p.percentage}% _(@ $${parseFloat(p.avg_price).toLocaleString(undefined, { maximumFractionDigits: 4 })})_\n`;
  });

  const cashExposurePct = (100 - cryptoExposurePct).toFixed(1);
  cryptoExposurePct = cryptoExposurePct.toFixed(1);
  const cryptoVal = totalEquity * (cryptoExposurePct / 100);
  const cashVal = totalEquity * (cashExposurePct / 100);

  const filledBoxes = Math.round(cryptoExposurePct / 10);
  const exposureBar = "🟩".repeat(filledBoxes) + "⬜".repeat(10 - filledBoxes);

  let message = `🏛 *QUANT ORACLE TERMINAL*\n`;
  message += `_Daily Execution: ${new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} WIB_\n\n`;
  message += `🌐 *MACRO REGIME*\nStatus: _${regimeStatus}_\n\n`;
  message += `🛡️ *SYSTEM EXPOSURE*\n[${exposureBar}] *${cryptoExposurePct}%*\n`;
  message += `• Crypto Assets: *$${cryptoVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n`;
  message += `• Cash Reserve : *$${cashVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n\n`;
  message += `💰 *EQUITY & PERFORMANCE*\n`;
  message += `• Total Capital: *$${totalEquity.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n`;
  message += `• System ROI : *${last.system_roi}%*\n`;
  message += `• Max Drawdown: \`${last.max_drawdown}%\`\n\n`;
  message += `📊 *ACTIVE ALLOCATIONS*\n`;

  if (hasCrypto) message += activePositionsText;
  else message += `⚠️ _100% CASH MODE ACTIVE (Awaiting Macro Clear)_\n`;

  message += `\n📈 *ALPHA (VS BENCHMARK)*\n`;
  message += `• System : ${last.system_roi}%\n`;
  message += `• Bitcoin: ${last.btc_roi}%\n`;
  message += `• S&P 500: ${last.spx_roi}%\n\n`;

  const alpha = parseFloat(last.system_roi) - parseFloat(last.btc_roi);
  const status =
    alpha > 0
      ? `✅ BEATING MARKET BY +${alpha.toFixed(2)}%`
      : `⚠️ UNDERPERFORMING BTC BY ${Math.abs(alpha).toFixed(2)}%`;
  message += `*STATUS:* ${status}\n\n`;
  message += `🔗 [Dashboard Link](https://your-dashboard-url.vercel.app/)`;

  await sendTelegram(message);
}

// --- 3. ENGINE EXECUTION ---
async function recordTrade(
  symbol,
  type,
  price,
  amount,
  pnl_percent,
  executionTime,
) {
  const pnl_value = type === "SELL" ? price * amount * (pnl_percent / 100) : 0;
  await supabase.from("trade_history").insert([
    {
      symbol,
      type,
      exit_price: price,
      amount,
      pnl_percent,
      pnl_value,
      timestamp: executionTime,
    },
  ]);
}

async function executeLiveRebalancing(
  targetValues,
  currentHoldings,
  marketPrices,
  capitalUSDT,
  costBasis,
  totalEquity,
) {
  const serverTimeMs = Date.now();
  const rebalanceThreshold = totalEquity * 0.05;
  let isSellExecuted = false;
  let newCapitalUSDT = capitalUSDT;
  let newHoldings = { ...currentHoldings };
  let newCostBasis = { ...costBasis };

  for (const symbol of Object.keys(targetValues)) {
    const currentPrice = marketPrices[symbol];
    if (!currentPrice) continue;
    const currentVal = newHoldings[symbol] * currentPrice;
    const targetVal = targetValues[symbol];
    const diff = targetVal - currentVal;

    if (diff < -rebalanceThreshold || (targetVal === 0 && currentVal > 10)) {
      const sellQty = Math.min(
        Math.abs(diff) / currentPrice,
        newHoldings[symbol],
      );
      if (sellQty > 0) {
        let avgPrice = 0,
          pnl_percent = 0;
        if (newHoldings[symbol] > 0) {
          avgPrice = newCostBasis[symbol] / newHoldings[symbol];
          pnl_percent = ((currentPrice - avgPrice) / avgPrice) * 100;
        }
        await recordTrade(
          symbol,
          "SELL",
          currentPrice,
          sellQty,
          pnl_percent,
          new Date(serverTimeMs).toISOString(),
        );

        const ratio = sellQty / newHoldings[symbol];
        newCostBasis[symbol] -= newCostBasis[symbol] * ratio;
        newCapitalUSDT += sellQty * currentPrice;
        newHoldings[symbol] -= sellQty;
        isSellExecuted = true;
      }
    }
  }

  for (const symbol of Object.keys(targetValues)) {
    const currentPrice = marketPrices[symbol];
    if (!currentPrice) continue;
    const currentVal = newHoldings[symbol] * currentPrice;
    const targetVal = targetValues[symbol];
    const diff = targetVal - currentVal;

    if (diff > rebalanceThreshold) {
      const buyAmount = Math.min(diff, newCapitalUSDT);
      if (buyAmount > 10) {
        const buyQty = buyAmount / currentPrice;
        const delayMs = isSellExecuted ? 1500 : 0;
        await recordTrade(
          symbol,
          "BUY",
          currentPrice,
          buyQty,
          0,
          new Date(serverTimeMs + delayMs).toISOString(),
        );

        newCapitalUSDT -= buyAmount;
        newHoldings[symbol] = (newHoldings[symbol] || 0) + buyQty;
        newCostBasis[symbol] = (newCostBasis[symbol] || 0) + buyAmount;
      }
    }
  }
  return { newHoldings, newCapitalUSDT, newCostBasis };
}

// --- 4. MAIN QUANT ORACLE ---
async function runDailyOracle() {
  console.log("🚀 MENGAKTIFKAN QUANT ORACLE (1:1 PARITY MODE)...");

  try {
    // 1. Tarik Memori dari Database
    const { data: dbPositions } = await supabase
      .from("current_positions")
      .select("*");
    let currentHoldings = {},
      costBasis = {},
      athPrices = {};
    let capitalUSDT = 10000;

    if (dbPositions) {
      dbPositions.forEach((p) => {
        if (p.symbol !== "USDT") {
          const qty = parseFloat(p.amount || 0);
          currentHoldings[p.symbol + "USDT"] = qty;
          costBasis[p.symbol + "USDT"] = qty * parseFloat(p.avg_price || 0);
          athPrices[p.symbol + "USDT"] = parseFloat(p.ath_price || 0); // Menarik memori ATH
        } else {
          capitalUSDT = parseFloat(p.amount || 0);
        }
      });
    }

    // 2. Fetch History (Market, Makro, Derivatives)
    const { data: dbAssets } = await supabase
      .from("assets")
      .select("id, symbol");
    const assetMap = new Map(dbAssets.map((a) => [a.symbol, a.id]));

    let marketDataLists = {},
      marketVolumeLists = {},
      marketPrices = {};
    for (const symbol of targetCoins) {
      const { data } = await supabase
        .from("market_data")
        .select("close, volume")
        .eq("asset_id", assetMap.get(symbol))
        .order("timestamp", { ascending: false })
        .limit(200);
      const history = (data || []).reverse();
      marketDataLists[symbol] = history.map((h) => parseFloat(h.close));
      marketVolumeLists[symbol] = history.map((h) => parseFloat(h.volume));
      marketPrices[symbol] =
        marketDataLists[symbol][marketDataLists[symbol].length - 1];
    }

    const { data: dxyData } = await supabase
      .from("macro_data")
      .select("close")
      .eq("symbol", "DXY")
      .order("timestamp", { ascending: false })
      .limit(200);
    const dxyPrices = (dxyData || []).reverse().map((d) => parseFloat(d.close));

    const { data: spxData } = await supabase
      .from("macro_data")
      .select("close")
      .eq("symbol", "SPX")
      .order("timestamp", { ascending: false })
      .limit(1);
    const currentSPXPrice =
      spxData && spxData.length > 0 ? parseFloat(spxData[0].close) : 4100;

    // Fetch Derivatives (Open Interest 5 Hari Terakhir)
    let oiHistory = {};
    for (const symbol of targetCoins) {
      const { data } = await supabase
        .from("derivatives_data")
        .select("open_interest")
        .eq("symbol", symbol)
        .order("timestamp", { ascending: false })
        .limit(5);
      if (data && data.length >= 5) {
        oiHistory[symbol] = data
          .reverse()
          .map((d) => parseFloat(d.open_interest));
      }
    }

    // Kalkulasi Total Equity
    let currentCryptoValue = 0;
    for (const [sym, qty] of Object.entries(currentHoldings))
      currentCryptoValue += qty * (marketPrices[sym] || 0);
    const totalEquity = capitalUSDT + currentCryptoValue;

    // --- OTAK 1: REGIME & EXPOSURE ---
    const btcPrices = marketDataLists["BTCUSDT"];
    const currentBTCPrice = btcPrices[btcPrices.length - 1];
    const btcRoc14 = calculateROC(btcPrices, 14);
    const btcSma200 = calculateSMA(btcPrices, 200);
    const mayer = currentBTCPrice / btcSma200;

    let targetExposure = 0,
      regimeStatus = "";
    if (mayer < 0.75) {
      targetExposure = btcRoc14 > -15 ? 1.0 : 0.5;
      regimeStatus = "ACCUMULATION (DEEP DISCOUNT)";
    } else if (mayer >= 0.75 && mayer < 1.2) {
      targetExposure = 0.8;
      regimeStatus = "RECOVERY / FAIR VALUE";
    } else if (mayer >= 1.2 && mayer < 2.0) {
      targetExposure = 0.6;
      regimeStatus = "MARKUP (BULLISH)";
    } else {
      targetExposure = 0.2;
      regimeStatus = "DISTRIBUTION (OVERVALUED)";
    }

    if (dxyPrices.length > 50) {
      const dxyEma20 = calculateEMA(dxyPrices.slice(-100), 20);
      const dxyEma50 = calculateEMA(dxyPrices.slice(-100), 50);
      const dxyRoc14 = calculateROC(dxyPrices, 14);
      if (dxyEma20 > dxyEma50 && dxyRoc14 > 2 && btcRoc14 < -10) {
        targetExposure = 0.0;
        regimeStatus = "CRITICAL MACRO RISK (100% CASH)";
      }
    }

    // --- OTAK 2: ROTASI SEKTORAL & OI ---
    let dailyMomentum = [],
      emergencySells = [];
    const trailingStopTolerance = 0.15;

    for (const symbol of targetCoins) {
      const prices = marketDataLists[symbol];
      const vols = marketVolumeLists[symbol];
      if (prices.length < 50) continue;

      const currentP = marketPrices[symbol];

      // Update Memori ATH
      if (currentHoldings[symbol] > 0) {
        if (currentP > (athPrices[symbol] || 0)) athPrices[symbol] = currentP;
        const dropFromAth = (athPrices[symbol] - currentP) / athPrices[symbol];
        if (dropFromAth >= trailingStopTolerance) {
          emergencySells.push(symbol);
          athPrices[symbol] = 0;
        }
      }

      const sma50 = calculateSMA(prices, 50);
      const distanceToSma50 = ((currentP - sma50) / sma50) * 100;
      const roc14 = calculateROC(prices, 14);
      const roc30 = calculateROC(prices, 30);

      if (roc14 > 0 && distanceToSma50 < 40) {
        const currentVol = vols[vols.length - 1];
        const avgVol20 = calculateSMA(vols.slice(-20), 20);
        let smartMoneyMultiplier = 1.0;
        if (currentVol > avgVol20 * 2.5) smartMoneyMultiplier = 2.0;
        else if (currentVol > avgVol20 * 1.5) smartMoneyMultiplier = 1.5;

        // Logika Open Interest (OI) Dikembalikan 100%
        let oiMultiplier = 1.0;
        if (oiHistory[symbol] && oiHistory[symbol].length === 5) {
          const currentOI = oiHistory[symbol][4];
          const pastOI = oiHistory[symbol][0];
          const oiChange = ((currentOI - pastOI) / pastOI) * 100;
          if (oiChange > 15 && distanceToSma50 < 20) oiMultiplier = 1.5;
          else if (oiChange < -10) oiMultiplier = 0.1;
        }

        const baseScore = roc14 * 0.6 + roc30 * 0.4;
        if (baseScore > 0)
          dailyMomentum.push({
            symbol,
            finalQuantScore: baseScore * smartMoneyMultiplier * oiMultiplier,
          });
      }
    }

    // --- OTAK 3: EKSEKUSI ---
    const totalCryptoBudget = totalEquity * targetExposure;
    let targetValues = {};
    targetCoins.forEach((coin) => (targetValues[coin] = 0));

    dailyMomentum.sort((a, b) => b.finalQuantScore - a.finalQuantScore);
    const safePicks = dailyMomentum.filter(
      (item) => !emergencySells.includes(item.symbol),
    );
    const topPicks = safePicks.slice(0, 3);
    const totalScore = topPicks.reduce(
      (sum, item) => sum + item.finalQuantScore,
      0,
    );

    if (totalScore > 0) {
      topPicks.forEach((pick) => {
        targetValues[pick.symbol] =
          totalCryptoBudget * (pick.finalQuantScore / totalScore);
      });
    }

    const { newHoldings, newCapitalUSDT, newCostBasis } =
      await executeLiveRebalancing(
        targetValues,
        currentHoldings,
        marketPrices,
        capitalUSDT,
        costBasis,
        totalEquity,
      );

    // --- 5. UPDATE DATABASE (STATE PERSISTENCE) ---
    const START_CAPITAL = parseFloat(process.env.INCEPTION_CAPITAL || "10000");
    const START_BTC_PRICE = parseFloat(
      process.env.INCEPTION_BTC_PRICE || "40581",
    );
    const START_SPX_PRICE = parseFloat(
      process.env.INCEPTION_SPX_PRICE || "4100",
    );

    // Ambil Peak Value dari History untuk kalkulasi Max Drawdown yang Dinamis
    const { data: allHistory } = await supabase
      .from("portfolio_history")
      .select("total_value");
    let peakValue = START_CAPITAL;
    if (allHistory) {
      allHistory.forEach((h) => {
        const val = parseFloat(h.total_value);
        if (val > peakValue) peakValue = val;
      });
    }
    if (totalEquity > peakValue) peakValue = totalEquity;
    const maxDrawdown = ((peakValue - totalEquity) / peakValue) * 100;

    const currentSystemRoi = (
      ((totalEquity - START_CAPITAL) / START_CAPITAL) *
      100
    ).toFixed(2);
    const currentBtcRoi = (
      ((currentBTCPrice - START_BTC_PRICE) / START_BTC_PRICE) *
      100
    ).toFixed(2);
    const currentSpxRoi = (
      ((currentSPXPrice - START_SPX_PRICE) / START_SPX_PRICE) *
      100
    ).toFixed(2); // SPX Kini Dinamis

    const todayOnly = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Jakarta",
    }).format(new Date());
    await supabase.from("portfolio_history").upsert(
      [
        {
          date: todayOnly,
          total_value: totalEquity.toFixed(2),
          cash_value: newCapitalUSDT.toFixed(2),
          crypto_value: (totalEquity - newCapitalUSDT).toFixed(2),
          system_roi: currentSystemRoi,
          btc_roi: currentBtcRoi,
          spx_roi: currentSpxRoi,
          max_drawdown: maxDrawdown.toFixed(2),
        },
      ],
      { onConflict: "date" },
    );

    await supabase.from("current_positions").delete().neq("symbol", "DUMMY");
    let finalPositions = [
      {
        symbol: "USDT",
        percentage: ((newCapitalUSDT / totalEquity) * 100).toFixed(2),
        amount: newCapitalUSDT.toFixed(2),
        ath_price: 0,
      },
    ];

    for (const [symbol, qty] of Object.entries(newHoldings)) {
      const price = marketPrices[symbol];
      const val = qty * price;
      const pct = (val / totalEquity) * 100;
      if (pct > 1) {
        finalPositions.push({
          symbol: symbol.replace("USDT", ""),
          percentage: pct.toFixed(2),
          avg_price: (newCostBasis[symbol] / qty).toFixed(4),
          amount: qty.toFixed(6),
          ath_price: athPrices[symbol] || marketPrices[symbol], // Simpan ATH ke memori Database
        });
      }
    }
    await supabase.from("current_positions").insert(finalPositions);

    // --- 6. TELEGRAM ---
    await broadcastUpdate(regimeStatus, totalEquity, newCapitalUSDT);
  } catch (error) {
    console.error("❌ ERROR:", error);
    await sendTelegram(
      `🚨 *SYSTEM ALERT*\nError saat menjalankan Daily Oracle:\n\`${error.message}\``,
    );
  }
}

runDailyOracle();
