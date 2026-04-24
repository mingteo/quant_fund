require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// Inisialisasi Supabase menggunakan Service Role Key agar tidak terblokir RLS
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Target Universe Quant
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

// ====================================================================
// 1. FUNGSI MATEMATIKA & INDIKATOR KUANTITATIF
// ====================================================================
function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
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

// ====================================================================
// 2. MODUL TELEGRAM BROADCAST
// ====================================================================
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
  console.log("📢 PREPARING QUANT ORACLE BROADCAST...");

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
  message += `_Daily Execution: ${new Date().toLocaleString("id-ID")}_\n\n`;

  message += `🌐 *MACRO REGIME*\n`;
  message += `Status: _${regimeStatus}_\n\n`;

  message += `🛡️ *SYSTEM EXPOSURE*\n`;
  message += `[${exposureBar}] *${cryptoExposurePct}%*\n`;
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

// ====================================================================
// 3. ENGINE EXECUTION (HYSTERESIS 5% & REALTIME TIMESTAMPS)
// ====================================================================
async function recordTrade(
  symbol,
  type,
  price,
  amount,
  pnl_percent,
  executionTime,
) {
  const pnl_value = type === "SELL" ? price * amount * (pnl_percent / 100) : 0;
  const { error } = await supabase.from("trade_history").insert([
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
  if (error)
    console.error(`❌ Gagal mencatat audit ${type} ${symbol}:`, error.message);
  else
    console.log(`✅ Audit tercatat: ${type} ${symbol} pada ${executionTime}`);
}

async function executeLiveRebalancing(
  targetValues,
  currentHoldings,
  marketPrices,
  capitalUSDT,
  costBasis,
  totalEquity,
) {
  console.log("\n🤖 MEMULAI ORACLE LIVE REBALANCING...");
  const serverTimeMs = Date.now();

  // 🔥 THE HYSTERESIS BAND (Mencegah Over-Trading)
  const rebalanceThreshold = totalEquity * 0.05;
  console.log(
    `🛡️ Hysteresis Aktif: Mengabaikan fluktuasi di bawah $${rebalanceThreshold.toFixed(2)}`,
  );

  let isSellExecuted = false;
  let newCapitalUSDT = capitalUSDT;
  let newHoldings = { ...currentHoldings };
  let newCostBasis = { ...costBasis };

  // --- FASE 1: EKSEKUSI SELL ---
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
        let avgPrice = 0;
        let pnl_percent = 0;
        if (newHoldings[symbol] > 0) {
          avgPrice = newCostBasis[symbol] / newHoldings[symbol];
          pnl_percent = ((currentPrice - avgPrice) / avgPrice) * 100;
        }

        const liveSellTime = new Date(serverTimeMs).toISOString();
        await recordTrade(
          symbol,
          "SELL",
          currentPrice,
          sellQty,
          pnl_percent,
          liveSellTime,
        );

        const ratio = sellQty / newHoldings[symbol];
        newCostBasis[symbol] -= newCostBasis[symbol] * ratio;
        newCapitalUSDT += sellQty * currentPrice;
        newHoldings[symbol] -= sellQty;
        isSellExecuted = true;
      }
    }
  }

  // --- FASE 2: EKSEKUSI BUY ---
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
        const liveBuyTime = new Date(serverTimeMs + delayMs).toISOString();

        await recordTrade(symbol, "BUY", currentPrice, buyQty, 0, liveBuyTime);

        newCapitalUSDT -= buyAmount;
        newHoldings[symbol] = (newHoldings[symbol] || 0) + buyQty;
        newCostBasis[symbol] = (newCostBasis[symbol] || 0) + buyAmount;
      }
    }
  }

  return { newHoldings, newCapitalUSDT, newCostBasis };
}

// ====================================================================
// 4. MAIN ORCHESTRATOR (THE QUANT BRAIN)
// ====================================================================
async function runDailyOracle() {
  console.log("🚀 MENGAKTIFKAN QUANT ORACLE (LIVE PROD)...");

  try {
    // 1. Tarik Data Posisi Dompet (Holdings) Saat Ini
    const { data: dbPositions } = await supabase
      .from("current_positions")
      .select("*");
    let currentHoldings = {};
    let costBasis = {};
    let capitalUSDT = 10000;

    if (dbPositions) {
      dbPositions.forEach((p) => {
        if (p.symbol !== "USDT") {
          const qty = parseFloat(p.amount || 0);
          currentHoldings[p.symbol + "USDT"] = qty;
          costBasis[p.symbol + "USDT"] = qty * parseFloat(p.avg_price || 0);
        } else {
          capitalUSDT = parseFloat(p.amount || 0);
        }
      });
    }

    // 2. Fetch Historical Data (200 Hari) untuk Kalkulasi Indikator
    const fetchHistoryLimit = async (table, selectStr, eqKey, eqVal) => {
      const { data } = await supabase
        .from(table)
        .select(selectStr)
        .eq(eqKey, eqVal)
        .order("timestamp", { ascending: false })
        .limit(200);
      return (data || []).reverse(); // Reverse agar urutan waktu dari lama ke baru
    };

    const { data: dbAssets } = await supabase
      .from("assets")
      .select("id, symbol");
    const assetMap = new Map(dbAssets.map((a) => [a.symbol, a.id]));

    let marketDataLists = {};
    let marketVolumeLists = {};
    let marketPrices = {}; // Harga hari ini

    for (const symbol of targetCoins) {
      const history = await fetchHistoryLimit(
        "market_data",
        "close, volume",
        "asset_id",
        assetMap.get(symbol),
      );
      marketDataLists[symbol] = history.map((h) => parseFloat(h.close));
      marketVolumeLists[symbol] = history.map((h) => parseFloat(h.volume));
      marketPrices[symbol] =
        marketDataLists[symbol][marketDataLists[symbol].length - 1];
    }

    const dxyHistory = await fetchHistoryLimit(
      "macro_data",
      "close",
      "symbol",
      "DXY",
    );
    const btcPrices = marketDataLists["BTCUSDT"];
    const dxyPrices = dxyHistory.map((d) => parseFloat(d.close));

    // Kalkulasi Total Equity Live
    let currentCryptoValue = 0;
    for (const [sym, qty] of Object.entries(currentHoldings)) {
      currentCryptoValue += qty * (marketPrices[sym] || 0);
    }
    const totalEquity = capitalUSDT + currentCryptoValue;

    // ==========================================
    // OTAK QUANT: TAHAP 1 - REGIME & EXPOSURE
    // ==========================================
    const currentBTCPrice = btcPrices[btcPrices.length - 1];
    const btcRoc14 = calculateROC(btcPrices, 14);
    const btcSma200 = calculateSMA(btcPrices, 200);
    const mayer = currentBTCPrice / btcSma200;

    let targetExposure = 0;
    let regimeStatus = "";

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

    // THE KILL SWITCH
    if (dxyPrices.length > 50) {
      const dxyEma20 = calculateEMA(dxyPrices.slice(-100), 20);
      const dxyEma50 = calculateEMA(dxyPrices.slice(-100), 50);
      const dxyRoc14 = calculateROC(dxyPrices, 14);
      if (dxyEma20 > dxyEma50 && dxyRoc14 > 2 && btcRoc14 < -10) {
        targetExposure = 0.0;
        regimeStatus = "CRITICAL MACRO RISK (100% CASH)";
      }
    }

    // ==========================================
    // OTAK QUANT: TAHAP 2 - ROTASI SEKTORAL
    // ==========================================
    let dailyMomentum = [];
    let emergencySells = []; // Stateless Trailing Stop

    for (const symbol of targetCoins) {
      const prices = marketDataLists[symbol];
      const vols = marketVolumeLists[symbol];
      if (prices.length < 50) continue;

      const currentP = marketPrices[symbol];

      // Stateless Trailing Stop Logic (Mencari titik tertinggi 14 hari terakhir)
      if (currentHoldings[symbol]) {
        const rollingHigh14D = Math.max(...prices.slice(-14));
        if ((rollingHigh14D - currentP) / rollingHigh14D >= 0.15) {
          emergencySells.push(symbol);
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

        // Note: Simplifikasi OI Tracker karena struktur DB Derivatives rumit dipanggil live.
        // Kita andalkan Volume on-chain sebagai proxy smart money.
        const baseScore = roc14 * 0.6 + roc30 * 0.4;
        if (baseScore > 0) {
          dailyMomentum.push({
            symbol,
            finalQuantScore: baseScore * smartMoneyMultiplier,
          });
        }
      }
    }

    // ==========================================
    // OTAK QUANT: TAHAP 3 - PEMBOBOTAN ASIMETRIS
    // ==========================================
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
        const weight = pick.finalQuantScore / totalScore;
        targetValues[pick.symbol] = totalCryptoBudget * weight;
      });
    }

    // Eksekusi Live
    const { newHoldings, newCapitalUSDT, newCostBasis } =
      await executeLiveRebalancing(
        targetValues,
        currentHoldings,
        marketPrices,
        capitalUSDT,
        costBasis,
        totalEquity,
      );

    // ==========================================
    // 5. UPDATE DATABASE
    // ==========================================
    const START_CAPITAL = parseFloat(process.env.INCEPTION_CAPITAL || "10000");
    const START_BTC_PRICE = parseFloat(
      process.env.INCEPTION_BTC_PRICE || "40581",
    );
    const currentSystemRoi = (
      ((totalEquity - START_CAPITAL) / START_CAPITAL) *
      100
    ).toFixed(2);
    const currentBtcRoi = (
      ((currentBTCPrice - START_BTC_PRICE) / START_BTC_PRICE) *
      100
    ).toFixed(2);

    const todayOnly = new Date().toISOString().split("T")[0];
    await supabase.from("portfolio_history").upsert(
      [
        {
          date: todayOnly,
          total_value: totalEquity.toFixed(2),
          cash_value: newCapitalUSDT.toFixed(2),
          crypto_value: (totalEquity - newCapitalUSDT).toFixed(2),
          system_roi: currentSystemRoi,
          btc_roi: currentBtcRoi,
          spx_roi: 47.43, // Fallback statis
          max_drawdown: 39.83,
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
        });
      }
    }
    await supabase.from("current_positions").insert(finalPositions);

    // 6. BROADCAST TELEGRAM
    await broadcastUpdate(regimeStatus, totalEquity, newCapitalUSDT);
  } catch (error) {
    console.error("❌ ERROR FATAL DALAM EKSEKUSI DAILY BOT:", error);
    await sendTelegram(
      `🚨 *SYSTEM ALERT*\nError saat menjalankan Daily Oracle:\n\`${error.message}\``,
    );
  }
}

runDailyOracle();
