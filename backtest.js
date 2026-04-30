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
  console.log("🚀 MEMULAI BACKTEST V1: FR/OI + LOGS (TANPA RANK BUFFER)...");

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

  // Tarik data OI beserta Funding Rate
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
        fr: parseFloat(row.funding_rate || 0), // Menyimpan nilai Funding Rate
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
  let tradeHistoryRecords = [];
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
    // TAHAP 1: SMART REGIME & EXPOSURE (QUANTITATIVE CONTRARIAN)
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

    const availableDXY = dxyTimeline
      .filter((d) => d.dateOnly <= dateOnly)
      .map((d) => d.close);
    if (availableDXY.length > 50) {
      const dxyEma20 = calculateEMA(availableDXY.slice(-100), 20);
      const dxyEma50 = calculateEMA(availableDXY.slice(-100), 50);
      const dxyRoc14 = calculateROC(availableDXY, 14);
      if (dxyEma20 > dxyEma50 && dxyRoc14 > 2 && btcRoc14 < -10) {
        targetExposure = 0.0;
        regimeStatus = "CRITICAL MACRO RISK (100% CASH)";
      }
    }

    // =========================================================
    // TAHAP 2: RANKING MOMENTUM & ROTASI SEKTORAL (WITH FR - NO BUFFER)
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

        // Implementasi logika OI & FR
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
          // PURE SCORE, TIDAK ADA RANK BUFFER DISINI (V1)
          let finalScore =
            baseScore * smartMoneyMultiplier * oiMultiplier * frMultiplier;

          dailyMomentum.push({
            symbol,
            finalQuantScore: finalScore,
          });
        }
      }
    }

    // =========================================================
    // TAHAP 3: THE PROFIT LOCKER (TRAILING STOP)
    // =========================================================
    const trailingStopTolerance = 0.15;
    let emergencySells = [];
    let actionLog = [];

    for (const symbol of targetCoins) {
      if (holdings[symbol] > 0) {
        const currentPrice = marketData[symbol]?.get(todayStr);
        if (currentPrice > athPrices[symbol]) athPrices[symbol] = currentPrice;

        const dropFromAth =
          (athPrices[symbol] - currentPrice) / athPrices[symbol];
        if (dropFromAth >= trailingStopTolerance) {
          emergencySells.push(symbol);
          actionLog.push(`🚨 TS-TRIGGER: ${symbol.replace("USDT", "")}`);
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

      if (diff < -rebalanceThreshold || (targetVal === 0 && currentVal > 10)) {
        const sellQty = Math.min(
          Math.abs(diff) / currentPrice,
          holdings[symbol],
        );

        if (sellQty > 0) {
          let avgPrice = 0;
          let pnl_percent = 0;
          let pnl_value = 0;

          if (holdings[symbol] > 0) {
            avgPrice = costBasis[symbol] / holdings[symbol];
            pnl_percent = ((currentPrice - avgPrice) / avgPrice) * 100;
            pnl_value = (currentPrice - avgPrice) * sellQty;
          }

          let sellDate = new Date(todayStr);
          sellDate.setUTCHours(10, 0, 0, 0);

          tradeHistoryRecords.push({
            symbol: symbol,
            type: "SELL",
            entry_price: avgPrice,
            exit_price: currentPrice,
            amount: sellQty,
            pnl_percent: pnl_percent,
            pnl_value: pnl_value,
            timestamp: sellDate.toISOString(),
          });

          const ratio = sellQty / holdings[symbol];
          costBasis[symbol] -= costBasis[symbol] * ratio;
          capitalUSDT += sellQty * currentPrice;
          holdings[symbol] -= sellQty;

          actionLog.push(`-${symbol.replace("USDT", "")}`);
          dayHasTrades = true;
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

      if (diff > rebalanceThreshold) {
        const buyAmount = Math.min(diff, capitalUSDT);

        if (buyAmount > 10) {
          const buyQty = buyAmount / currentPrice;

          let buyDate = new Date(todayStr);
          buyDate.setUTCHours(10, 20, 0, 0);

          tradeHistoryRecords.push({
            symbol: symbol,
            type: "BUY",
            entry_price: currentPrice,
            exit_price: currentPrice,
            amount: buyQty,
            pnl_percent: 0,
            pnl_value: 0,
            timestamp: buyDate.toISOString(),
          });

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
      console.log(`🗓️  [${dateOnly}] ORACLE PORTFOLIO UPDATE (V1)`);
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
    // TAHAP 6: RECORDING
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
      cash_value: capitalUSDT.toFixed(2),
      crypto_value: (currentPortfolioValue - capitalUSDT).toFixed(2),
      system_roi: (((currentPortfolioValue - 200) / 200) * 100).toFixed(2),
      btc_roi: (
        ((currentBTCPrice - startBTCPrice) / startBTCPrice) *
        100
      ).toFixed(2),
      spx_roi: (
        ((currentSPXPrice - startSPXPrice) / startSPXPrice) *
        100
      ).toFixed(2),
      max_drawdown: maxDrawdown.toFixed(2),
    });
  }

  // --- 4. PENYIMPANAN DATA (SYNC KE SUPABASE) - DINONAKTIFKAN ---
  console.log(
    "\nℹ️ Info: Penulisan data hasil simulasi ke database Supabase telah dinonaktifkan secara aman.",
  );

  // --- KESIMPULAN AKHIR ---
  const lastRecord = dailyRecords[dailyRecords.length - 1];
  const finalValue = parseFloat(lastRecord.total_value);
  const totalROI = parseFloat(lastRecord.system_roi);
  const finalBTCROI = parseFloat(lastRecord.btc_roi);
  const finalSPXROI = parseFloat(lastRecord.spx_roi);

  console.log(
    `\n╔════════════════════════════════════════════════════════════╗`,
  );
  console.log(`║      🏆 HASIL AKHIR BACKTEST V1 (TANPA RANK BUFFER)        ║`);
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(`   💰 Modal Awal          : $200.00                          `);
  console.log(
    `   💵 Nilai Akhir         : $${finalValue.toFixed(2).padStart(12)}               `,
  );
  console.log(
    `   🚀 Total Trades        : ${totalTrades.toString().padStart(12)} trades             `,
  );
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(
    `   📈 Return Sistem (ROI) : ${totalROI.toFixed(2).padStart(12)}%                `,
  );
  console.log(
    `   📉 Max Drawdown        : -${maxDrawdown.toFixed(2).padStart(11)}%                `,
  );
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(`║  📊 BENCHMARK COMPARISON:                                  ║`);
  console.log(
    `   🔸 Bitcoin Buy & Hold  : ${finalBTCROI.toFixed(2).padStart(12)}%                 `,
  );
  console.log(
    `   🔹 S&P 500 (Stock)     : ${finalSPXROI.toFixed(2).padStart(12)}%                 `,
  );
  console.log(
    `╚════════════════════════════════════════════════════════════╝\n`,
  );
}

runBacktest();
