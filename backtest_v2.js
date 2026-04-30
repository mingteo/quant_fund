require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);

// Helper Pagination Supabase (Bypass Maksimal 1000 Baris)
async function fetchAllSupabaseRows(table, select, eqObj, orderCol) {
  let allData = [];
  let from = 0;
  const limit = 1000;
  while (true) {
    let query = supabase.from(table).select(select);
    if (eqObj) {
      for (const [key, val] of Object.entries(eqObj))
        query = query.eq(key, val);
    }
    if (orderCol) query = query.order(orderCol, { ascending: true });

    const { data, error } = await query.range(from, from + limit - 1);
    if (error) {
      console.error(`Error fetching ${table}:`, error.message);
      break;
    }
    if (!data || data.length === 0) break;

    allData = allData.concat(data);
    if (data.length < limit) break;
    from += limit;
  }
  return allData;
}

// --- 1. FUNGSI MATEMATIKA (UTILITIES) ---
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

// --- 2. ENGINE BACKTEST UTAMA ---
async function runBacktest() {
  console.log(
    "🚀 MEMULAI BACKTEST V2: RANK BUFFER + SMART MONEY + BREAK-EVEN PROTOCOL...",
  );

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

  // A. Ambil Data Assets & Market
  const { data: assets } = await supabase
    .from("assets")
    .select("id, symbol")
    .in("symbol", targetCoins);
  const assetMap = new Map(assets.map((a) => [a.symbol, a.id]));

  let marketData = {};
  let marketVolume = {};

  for (const symbol of targetCoins) {
    const assetId = assetMap.get(symbol);
    if (!assetId) continue;
    const data = await fetchAllSupabaseRows(
      "market_data",
      "timestamp, close, volume",
      { asset_id: assetId },
      "timestamp",
    );
    marketData[symbol] = new Map(
      data.map((item) => [item.timestamp, parseFloat(item.close)]),
    );
    marketVolume[symbol] = new Map(
      data.map((item) => [item.timestamp, parseFloat(item.volume)]),
    );
  }

  // B. Ambil Data Makro & Derivatives (TERMASUK FUNDING RATE)
  const dxyData = await fetchAllSupabaseRows(
    "macro_data",
    "timestamp, close",
    { symbol: "DXY" },
    "timestamp",
  );
  let dxyTimeline = dxyData
    ? dxyData.map((item) => ({
        dateOnly: new Date(item.timestamp).toISOString().split("T")[0],
        close: parseFloat(item.close),
      }))
    : [];

  const spxData = await fetchAllSupabaseRows(
    "macro_data",
    "timestamp, close",
    { symbol: "SPX" },
    "timestamp",
  );
  let spxTimeline = spxData
    ? spxData.map((item) => ({
        dateOnly: new Date(item.timestamp).toISOString().split("T")[0],
        close: parseFloat(item.close),
      }))
    : [];

  const btcTimeline = await fetchAllSupabaseRows(
    "market_data",
    "*",
    { asset_id: assetMap.get("BTCUSDT") },
    "timestamp",
  );

  if (!btcTimeline || btcTimeline.length < 200) {
    console.error(
      "❌ ABORT: Data Market tidak cukup untuk Backtest (Butuh min 200 hari).",
    );
    return;
  }

  const { data: oiData } = await supabase
    .from("derivatives_data")
    .select("symbol, open_interest, funding_rate, timestamp")
    .order("timestamp", { ascending: true });

  let derivativesTimeline = {};
  if (oiData) {
    oiData.forEach((row) => {
      const sym = row.symbol;
      if (!derivativesTimeline[sym]) derivativesTimeline[sym] = [];
      derivativesTimeline[sym].push({
        dateOnly: new Date(row.timestamp).toISOString().split("T")[0],
        oi: parseFloat(row.open_interest),
        fr: parseFloat(row.funding_rate || 0),
      });
    });
  }

  // C. Inisialisasi Portofolio
  let capitalUSDT = 200;
  let holdings = {};
  let costBasis = {};
  let athPrices = {};
  targetCoins.forEach((coin) => {
    holdings[coin] = 0;
    costBasis[coin] = 0;
    athPrices[coin] = 0;
  });

  let peakValue = 200;
  let maxDrawdown = 0;
  let dailyRecords = [];
  let totalTrades = 0;

  const startIdx = 200;
  const startBTCPrice =
    marketData["BTCUSDT"]?.get(btcTimeline[startIdx].timestamp) || 1;
  const startSPXPrice =
    spxTimeline.find(
      (d) =>
        d.dateOnly >=
        new Date(btcTimeline[startIdx].timestamp).toISOString().split("T")[0],
    )?.close || 1;

  // --- 3. LOOPING SIMULASI HARIAN ---
  for (let i = startIdx; i < btcTimeline.length; i++) {
    const todayStr = btcTimeline[i].timestamp;
    const dateOnly = new Date(todayStr).toISOString().split("T")[0];

    const getPricesUpToToday = (symbol) => {
      let prices = [];
      for (let j = 0; j <= i; j++) {
        const time = btcTimeline[j].timestamp;
        if (marketData[symbol]?.has(time))
          prices.push(marketData[symbol].get(time));
      }
      return prices;
    };

    const btcPrices = getPricesUpToToday("BTCUSDT");
    if (btcPrices.length < 200) continue;
    const currentBTCPrice = btcPrices[btcPrices.length - 1];

    let currentCryptoValue = 0;
    for (const symbol of targetCoins) {
      currentCryptoValue +=
        holdings[symbol] * (marketData[symbol]?.get(todayStr) || 0);
    }
    let currentPortfolioValue = capitalUSDT + currentCryptoValue;

    // =========================================================
    // TAHAP 1: SMART REGIME & EXPOSURE
    // =========================================================
    const btcEma20 = calculateEMA(btcPrices.slice(-100), 20);
    const btcEma50 = calculateEMA(btcPrices.slice(-100), 50);
    const trendDirection = btcEma20 > btcEma50 ? "UPTREND" : "DOWNTREND";
    const btcRoc14 = calculateROC(btcPrices, 14);
    const btcSma200 = calculateSMA(btcPrices, 200);
    const mayer = currentBTCPrice / btcSma200;

    let targetExposure = 0;
    let regimeStatus = "";

    if (mayer < 0.75) {
      targetExposure = btcRoc14 > -15 ? 1.0 : 0.5;
      regimeStatus = "ACCUMULATION";
    } else if (mayer >= 0.75 && mayer < 1.2) {
      targetExposure = 0.8;
      regimeStatus = "FAIR VALUE";
    } else if (mayer >= 1.2 && mayer < 2.0) {
      targetExposure = 0.6;
      regimeStatus = "MARKUP";
    } else {
      targetExposure = 0.2;
      regimeStatus = "DISTRIBUTION";
    }

    const availableDXY = dxyTimeline
      .filter((d) => d.dateOnly <= dateOnly)
      .map((d) => d.close);
    if (availableDXY.length > 50) {
      const dxyEma20 = calculateEMA(availableDXY.slice(-100), 20);
      const dxyEma50 = calculateEMA(availableDXY.slice(-100), 50);
      const dxyRoc14 = calculateROC(availableDXY, 14);
      if (dxyEma20 > dxyEma50 && dxyRoc14 > 2 && btcRoc14 < -10) {
        targetExposure = 0.0;
        regimeStatus = "MACRO RISK";
      }
    }

    // =========================================================
    // TAHAP 2: RANKING MOMENTUM DENGAN OI, FR, DAN RANK BUFFER
    // =========================================================
    const getVolumesUpToToday = (symbol) => {
      let vols = [];
      for (let j = 0; j <= i; j++) {
        const time = btcTimeline[j].timestamp;
        if (marketVolume[symbol]?.has(time))
          vols.push(marketVolume[symbol].get(time));
      }
      return vols;
    };

    let dailyMomentum = [];
    for (const symbol of targetCoins) {
      const prices = getPricesUpToToday(symbol);
      const vols = getVolumesUpToToday(symbol);
      if (prices.length < 50 || vols.length < 50) continue;

      const currentP = marketData[symbol]?.get(todayStr);
      if (!currentP) continue;

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

        let oiMultiplier = 1.0;
        let frMultiplier = 1.0;
        const availableDerivatives =
          derivativesTimeline[symbol]?.filter((d) => d.dateOnly <= dateOnly) ||
          [];

        if (availableDerivatives.length >= 5) {
          const currentDeriv =
            availableDerivatives[availableDerivatives.length - 1];
          const pastDeriv =
            availableDerivatives[availableDerivatives.length - 5];

          const oiChange =
            ((currentDeriv.oi - pastDeriv.oi) / pastDeriv.oi) * 100;
          if (oiChange > 15 && distanceToSma50 < 20) oiMultiplier = 1.5;
          else if (oiChange < -10) oiMultiplier = 0.1;

          if (currentDeriv.fr < -0.0005) frMultiplier = 1.2;
          else if (currentDeriv.fr > 0.001) frMultiplier = 0.8;
        }

        const baseScore = roc14 * 0.6 + roc30 * 0.4;

        if (baseScore > 0) {
          let finalScore =
            baseScore * smartMoneyMultiplier * oiMultiplier * frMultiplier;

          // 🛡️ RANK BUFFER SYSTEM (THE INCUMBENT BONUS)
          const currentHoldingValue = holdings[symbol] * currentP;
          if (currentHoldingValue > 10) {
            finalScore = finalScore * 1.15; // 15% Retention Hysteresis
          }

          dailyMomentum.push({
            symbol,
            finalQuantScore: finalScore,
          });
        }
      }
    }

    // =========================================================
    // TAHAP 3: THE PROFIT LOCKER (TRAILING STOP & BREAK-EVEN)
    // =========================================================
    const trailingStopTolerance = 0.15;
    const breakEvenActivation = 0.05; // 🛡️ Jaring aktif jika pernah profit 5%
    let emergencySells = [];
    let actionLog = [];

    for (const symbol of targetCoins) {
      if (holdings[symbol] > 0) {
        const currentPrice = marketData[symbol]?.get(todayStr);
        if (currentPrice > athPrices[symbol]) athPrices[symbol] = currentPrice;

        const avgPrice = costBasis[symbol] / holdings[symbol];
        const maxProfitReached = (athPrices[symbol] - avgPrice) / avgPrice;

        // Titik eksekusi normal (15% dari pucuk ATH)
        let stopPrice = athPrices[symbol] * (1 - trailingStopTolerance);

        // LOGIKA BREAK-EVEN: LINDUNGI MODAL JIKA SUDAH PROFIT!
        if (maxProfitReached >= breakEvenActivation) {
          const breakEvenPrice = avgPrice * 1.005; // Harga modal + 0.5% (Buat bayar fee Bybit)

          // Jika Trailing Stop (15% dari pucuk) ternyata berada DI BAWAH harga modal,
          // maka kita paksa jaring pengaman naik ke titik impas (Break-Even)
          if (breakEvenPrice > stopPrice) {
            stopPrice = breakEvenPrice;
          }
        }

        if (currentPrice <= stopPrice) {
          emergencySells.push(symbol);
          actionLog.push(`🛡️ PROTECT/TS: ${symbol.replace("USDT", "")}`);
          athPrices[symbol] = 0;
        }
      } else {
        athPrices[symbol] = 0;
      }
    }

    // =========================================================
    // TAHAP 4: ASYMMETRIC REBALANCING
    // =========================================================
    const totalCryptoBudget = currentPortfolioValue * targetExposure;
    const rebalanceThreshold = currentPortfolioValue * 0.05;
    let dayHasTrades = false;

    let targetValues = {};
    targetCoins.forEach((coin) => (targetValues[coin] = 0));

    dailyMomentum.sort((a, b) => b.finalQuantScore - a.finalQuantScore);
    if (targetExposure > 0 && dailyMomentum.length > 0) {
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
    }

    // --- FASE 1: EKSEKUSI SELL ---
    for (const symbol of targetCoins) {
      const currentPrice = marketData[symbol]?.get(todayStr);
      if (!currentPrice) continue;

      const currentVal = holdings[symbol] * currentPrice;
      const targetVal = targetValues[symbol];
      const diff = targetVal - currentVal;

      if (
        diff < -rebalanceThreshold ||
        (targetVal === 0 && currentVal > 10) ||
        emergencySells.includes(symbol)
      ) {
        const sellQty = Math.min(
          Math.abs(diff) / currentPrice,
          holdings[symbol],
        );

        // Paksa jual 100% jika kena jaring Break-Even / TS
        const finalSellQty = emergencySells.includes(symbol)
          ? holdings[symbol]
          : sellQty;

        if (finalSellQty > 0) {
          const ratio = finalSellQty / holdings[symbol];
          costBasis[symbol] -= costBasis[symbol] * ratio;
          capitalUSDT += finalSellQty * currentPrice;
          holdings[symbol] -= finalSellQty;

          if (!emergencySells.includes(symbol))
            actionLog.push(`-${symbol.replace("USDT", "")}`);
          dayHasTrades = true;
          totalTrades++;
        }
      }
    }

    // --- FASE 2: EKSEKUSI BUY ---
    for (const symbol of targetCoins) {
      const currentPrice = marketData[symbol]?.get(todayStr);
      if (!currentPrice) continue;

      const currentVal = holdings[symbol] * currentPrice;
      const targetVal = targetValues[symbol];
      const diff = targetVal - currentVal;

      if (diff > rebalanceThreshold && !emergencySells.includes(symbol)) {
        const buyAmount = Math.min(diff, capitalUSDT);

        if (buyAmount > 10) {
          const buyQty = buyAmount / currentPrice;

          capitalUSDT -= buyAmount;
          holdings[symbol] += buyQty;
          costBasis[symbol] += buyAmount;

          actionLog.push(`+${symbol.replace("USDT", "")}`);
          dayHasTrades = true;
          totalTrades++;
        }
      }
    }

    // =========================================================
    // TAHAP 5: LOG HARIAN (DI DALAM LOOP)
    // =========================================================
    if (dayHasTrades) {
      console.log(`\n=========================================`);
      console.log(`🗓️  [${dateOnly}] ORACLE PORTFOLIO UPDATE (V2)`);
      console.log(
        `📈 Market: ${regimeStatus} (${trendDirection}) | Mayer: ${mayer.toFixed(2)}x`,
      );

      const actionText =
        actionLog.length > 0 ? actionLog.join(", ") : "Rebalancing";
      console.log(
        `🔄 Aksi  : ${actionText} | Exp: ${(targetExposure * 100).toFixed(0)}%`,
      );
      console.log(
        `💰 Equity: $${currentPortfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
      );
      console.log(`\nCurrent Holdings:`);

      targetCoins.forEach((symbol) => {
        const currentPrice = marketData[symbol]?.get(todayStr);
        if (!currentPrice) return;
        const val = holdings[symbol] * currentPrice;
        const pct = (val / currentPortfolioValue) * 100;

        if (pct > 0.5) {
          const avgPrice = costBasis[symbol] / holdings[symbol];
          const pnlPct = ((currentPrice - avgPrice) / avgPrice) * 100;
          console.log(
            `${pct.toFixed(1).padStart(5)}% Spot ${symbol.replace("USDT", "").padEnd(5)} ` +
              `($${avgPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} avg) ` +
              `[${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%]`,
          );
        }
      });

      const cashPct = (capitalUSDT / currentPortfolioValue) * 100;
      console.log(`${cashPct.toFixed(1).padStart(5)}% Cash (USDT)`);
      console.log(`=========================================`);
    }

    // =========================================================
    // TAHAP 6: RECORDING STATISTIK
    // =========================================================
    if (currentPortfolioValue > peakValue) peakValue = currentPortfolioValue;
    const currentDD = ((peakValue - currentPortfolioValue) / peakValue) * 100;
    if (currentDD > maxDrawdown) maxDrawdown = currentDD;

    const currentSPXPrice =
      spxTimeline.filter((d) => d.dateOnly <= dateOnly).pop()?.close ||
      startSPXPrice;

    dailyRecords.push({
      date: dateOnly,
      total_value: currentPortfolioValue.toFixed(2),
      system_roi: (((currentPortfolioValue - 200) / 200) * 100).toFixed(2),
      btc_roi: (
        ((currentBTCPrice - startBTCPrice) / startBTCPrice) *
        100
      ).toFixed(2),
      spx_roi: (
        ((currentSPXPrice - startSPXPrice) / startSPXPrice) *
        100
      ).toFixed(2),
    });
  }

  // --- KESIMPULAN AKHIR ---
  const lastRecord = dailyRecords[dailyRecords.length - 1];

  console.log(
    `\n╔════════════════════════════════════════════════════════════╗`,
  );
  console.log(`║ 🏆 HASIL AKHIR BACKTEST V2 (RANK BUFFER + BREAK-EVEN)      ║`);
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(`   💰 Modal Awal          : $200.00                          `);
  console.log(
    `   💵 Nilai Akhir         : $${parseFloat(lastRecord.total_value).toFixed(2).padStart(12)}               `,
  );
  console.log(
    `   🚀 Total Trades        : ${totalTrades.toString().padStart(12)} trades             `,
  );
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(
    `   📈 Return Sistem (ROI) : ${parseFloat(lastRecord.system_roi).toFixed(2).padStart(12)}%                `,
  );
  console.log(
    `   📉 Max Drawdown        : -${maxDrawdown.toFixed(2).padStart(11)}%                `,
  );
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(`║  📊 BENCHMARK COMPARISON:                                  ║`);
  console.log(
    `   🔸 Bitcoin Buy & Hold  : ${parseFloat(lastRecord.btc_roi).toFixed(2).padStart(12)}%                 `,
  );
  console.log(
    `   🔹 S&P 500 (Stock)     : ${parseFloat(lastRecord.spx_roi).toFixed(2).padStart(12)}%                 `,
  );
  console.log(
    `╚════════════════════════════════════════════════════════════╝\n`,
  );
}

runBacktest();
