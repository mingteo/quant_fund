require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// --- 1. FUNGSI MATEMATIKA (UTILITIES) ---
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

// --- 2. ENGINE BACKTEST UTAMA ---
async function runBacktest() {
  console.log("🚀 MEMULAI BACKTEST: VERSI QUANT BALANCED (GOLD)...");

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
  ];

  // A. Ambil Data Assets & Market
  const { data: assets } = await supabase
    .from("assets")
    .select("id, symbol")
    .in("symbol", targetCoins);
  const assetMap = new Map(assets.map((a) => [a.symbol, a.id]));

  let marketData = {};
  for (const symbol of targetCoins) {
    const assetId = assetMap.get(symbol);
    if (!assetId) continue;
    const { data } = await supabase
      .from("market_data")
      .select("timestamp, close")
      .eq("asset_id", assetId)
      .order("timestamp", { ascending: true });
    marketData[symbol] = new Map(
      data.map((item) => [item.timestamp, parseFloat(item.close)]),
    );
  }

  // B. Ambil Data Makro
  const { data: dxyData } = await supabase
    .from("macro_data")
    .select("timestamp, close")
    .eq("symbol", "DXY")
    .order("timestamp", { ascending: true });
  let dxyTimeline = dxyData
    ? dxyData.map((item) => ({
        dateOnly: new Date(item.timestamp).toISOString().split("T")[0],
        close: parseFloat(item.close),
      }))
    : [];

  const { data: spxData } = await supabase
    .from("macro_data")
    .select("timestamp, close")
    .eq("symbol", "SPX")
    .order("timestamp", { ascending: true });
  let spxTimeline = spxData
    ? spxData.map((item) => ({
        dateOnly: new Date(item.timestamp).toISOString().split("T")[0],
        close: parseFloat(item.close),
      }))
    : [];

  const { data: btcTimeline } = await supabase
    .from("market_data")
    .select("*")
    .eq("asset_id", assetMap.get("BTCUSDT"))
    .order("timestamp", { ascending: true });

  if (!btcTimeline || btcTimeline.length < 200) {
    console.error(
      "❌ ABORT: Data Market tidak cukup untuk Backtest (Butuh min 200 hari).",
    );
    console.log(
      "Saran: Pastikan fetchHistory.js berhasil mengisi market_data terlebih dahulu.",
    );
    return; // Hentikan script dengan sopan, bukan dengan error pecah
  }

  const startDate = btcTimeline[0].timestamp;

  // C. Inisialisasi Portofolio
  let capitalUSDT = 10000;
  let holdings = {};
  let costBasis = {};
  targetCoins.forEach((coin) => {
    holdings[coin] = 0;
    costBasis[coin] = 0;
  });
  let peakValue = 10000;
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

    // TAHAP 1: HITUNG TOTAL EQUITY
    let currentCryptoValue = 0;
    for (const symbol of targetCoins) {
      const p = marketData[symbol]?.get(todayStr) || 0;
      currentCryptoValue += holdings[symbol] * p;
    }
    let currentPortfolioValue = capitalUSDT + currentCryptoValue;

    // =========================================================
    // TAHAP 2: SMART REGIME & EXPOSURE (QUANTITATIVE CONTRARIAN)
    // =========================================================
    const btcEma20 = calculateEMA(btcPrices.slice(-100), 20);
    const btcEma50 = calculateEMA(btcPrices.slice(-100), 50);
    const trendDirection = btcEma20 > btcEma50 ? "UPTREND" : "DOWNTREND";
    const btcRoc14 = calculateROC(btcPrices, 14); // Kecepatan pergerakan harga
    const btcSma200 = calculateSMA(btcPrices, 200);
    const mayer = currentBTCPrice / btcSma200;

    let targetExposure = 0;
    let regimeStatus = "";

    // 1. Model Akumulasi Contrarian berbasis Deviasi Historis (Mayer)
    if (mayer < 0.75) {
      // EXTREME FEAR / DEEP DISCOUNT
      // Harga hancur jauh di bawah SMA 200. Smart money beraksi di sini.
      // Syarat perlindungan: Beli agresif HANYA JIKA harga tidak sedang terjun bebas (ROC > -15)
      targetExposure = btcRoc14 > -15 ? 1.0 : 0.5;
      regimeStatus = "ACCUMULATION (DEEP DISCOUNT)";
    } else if (mayer >= 0.75 && mayer < 1.2) {
      // FAIR VALUE / EARLY RECOVERY
      targetExposure = 0.8;
      regimeStatus = "RECOVERY / FAIR VALUE";
    } else if (mayer >= 1.2 && mayer < 2.0) {
      // BULL MARKET ONGOING
      // Harga sudah naik di atas rata-rata. Kita mulai kurangi paparan risiko perlahan.
      targetExposure = 0.6;
      regimeStatus = "MARKUP (BULLISH)";
    } else if (mayer >= 2.0) {
      // OVERVALUED / EUPHORIA
      // Ritel FOMO, sistem kita mengamankan profit dan hanya menyisakan sedikit posisi.
      targetExposure = 0.2;
      regimeStatus = "DISTRIBUTION (OVERVALUED)";
    }

    // 2. The Smart Kill-Switch (Korelasi DXY & Momentum Crash)
    let alerts = [];
    const availableDXY = dxyTimeline
      .filter((d) => d.dateOnly <= dateOnly)
      .map((d) => d.close);

    if (availableDXY.length > 50) {
      const dxyEma20 = calculateEMA(availableDXY.slice(-100), 20);
      const dxyEma50 = calculateEMA(availableDXY.slice(-100), 50);
      const dxyRoc14 = calculateROC(availableDXY, 14);

      // LOGIKA KILL-SWITCH: DXY meroket tajam DAN Bitcoin kehilangan momentum (darah tumpah)
      if (dxyEma20 > dxyEma50 && dxyRoc14 > 2 && btcRoc14 < -10) {
        targetExposure = 0.0; // 100% CASH. Tarik semua pasukan dari pasar.
        regimeStatus = "CRITICAL MACRO RISK (100% CASH)";
        alerts.push("DXY SPIKE + BTC CRASH DETECTED");
      }
    }

    // =========================================================
    // TAHAP 3: RANKING MOMENTUM & ROTASI SEKTORAL PRESISI
    // =========================================================
    let dailyMomentum = [];
    for (const symbol of targetCoins) {
      const prices = getPricesUpToToday(symbol);
      if (prices.length < 50) continue;

      const currentP = prices[prices.length - 1];
      const sma50 = calculateSMA(prices, 50);
      const distanceToSma50 = ((currentP - sma50) / sma50) * 100; // Seberapa jauh harga memompa

      const roc14 = calculateROC(prices, 14); // Momentum pendek
      const roc30 = calculateROC(prices, 30); // Momentum menengah

      // Filter Anti-Pucuk: Koin harus mulai naik (ROC14 > 0),
      // TAPI harganya belum overextended (maksimal 40% di atas SMA50)
      if (roc14 > 0 && distanceToSma50 < 40) {
        // Quant Scoring: Kombinasi kekuatan jangka pendek dan menengah
        const quantScore = roc14 * 0.6 + roc30 * 0.4;
        dailyMomentum.push({ symbol, quantScore });
      }
    }

    // Eksekusi: Ambil maksimal 3 Koin dengan skor kuantitatif tertinggi
    dailyMomentum.sort((a, b) => b.quantScore - a.quantScore);
    const topSymbols = dailyMomentum.slice(0, 3).map((c) => c.symbol);

    // TAHAP 4: REBALANCING
    const totalCryptoBudget = currentPortfolioValue * targetExposure;
    const budgetPerCoin =
      topSymbols.length > 0 ? totalCryptoBudget / topSymbols.length : 0;

    let dayHasTrades = false;
    let actionLog = [];

    for (const symbol of targetCoins) {
      const currentPrice = marketData[symbol]?.get(todayStr);
      if (!currentPrice) continue;

      const currentVal = holdings[symbol] * currentPrice;
      const targetVal = topSymbols.includes(symbol) ? budgetPerCoin : 0;
      const diff = targetVal - currentVal;

      if (Math.abs(diff) > 50) {
        if (diff > 0) {
          // BELI (DCA UP/DOWN)
          capitalUSDT -= diff;
          holdings[symbol] += diff / currentPrice;
          costBasis[symbol] += diff; // Tambah modal yang dikeluarkan
          actionLog.push(`+${symbol.replace("USDT", "")}`);
        } else {
          // JUAL (REDUCE/CLOSE)
          const sellQty = Math.abs(diff) / currentPrice;
          // Kurangi cost basis secara proporsional dengan jumlah yang dijual
          const ratio = sellQty / holdings[symbol];
          costBasis[symbol] -= costBasis[symbol] * ratio;

          capitalUSDT += Math.abs(diff);
          holdings[symbol] -= sellQty;
          actionLog.push(`-${symbol.replace("USDT", "")}`);
        }
        dayHasTrades = true;
        totalTrades++;
      }
    }

    // TAHAP 5: LOG HARIAN (DI DALAM LOOP)
    if (dayHasTrades) {
      console.log(`\n=========================================`);
      console.log(`🗓️  [${dateOnly}] ORACLE PORTFOLIO UPDATE`);
      console.log(
        `📈 Market: ${regimeStatus} (${trendDirection}) | Mayer: ${mayer.toFixed(2)}x`,
      );
      console.log(
        `🔄 Aksi  : ${actionLog.join(", ")} | Exp: ${(targetExposure * 100).toFixed(0)}%`,
      );
      console.log(
        `💰 Equity: $${currentPortfolioValue.toLocaleString(undefined, { minimumFractionDigits: 2 })}`,
      );
      console.log(`\nCurrent Holdings:`);

      targetCoins.forEach((symbol) => {
        const currentPrice = marketData[symbol]?.get(todayStr);
        const val = holdings[symbol] * currentPrice;
        const pct = (val / currentPortfolioValue) * 100;

        if (pct > 0.5) {
          // HITUNG AVG PRICE
          const avgPrice = costBasis[symbol] / holdings[symbol];
          const pnlPct = ((currentPrice - avgPrice) / avgPrice) * 100;

          console.log(
            `${pct.toFixed(1).padStart(5)}% Spot $${symbol.replace("USDT", "").padEnd(5)} ` +
              `($${avgPrice.toLocaleString(undefined, { maximumFractionDigits: 2 })} avg) ` +
              `[${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%]`,
          );
        }
      });

      const cashPct = (capitalUSDT / currentPortfolioValue) * 100;
      console.log(`${cashPct.toFixed(1).padStart(5)}% Cash (USDT)`);
      console.log(`=========================================`);
    }

    // TAHAP 6: RECORDING
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
      system_roi: (((currentPortfolioValue - 10000) / 10000) * 100).toFixed(2),
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

  // --- 4. PENYIMPANAN DATA (SYNC) ---
  console.log("\n📊 MENGIRIM DATA KE SUPABASE...");
  const chunkSize = 500;
  for (let i = 0; i < dailyRecords.length; i += chunkSize) {
    const chunk = dailyRecords.slice(i, i + chunkSize);
    await supabase
      .from("portfolio_history")
      .upsert(chunk, { onConflict: "date" });
  }

  // B. Simpan Rincian Posisi Terakhir
  await supabase.from("current_positions").delete().neq("symbol", "DUMMY");
  const lastRecord = dailyRecords[dailyRecords.length - 1];
  const lastDateStr = btcTimeline[btcTimeline.length - 1].timestamp;
  let finalPositions = [
    {
      symbol: "USDT",
      percentage: (
        (parseFloat(lastRecord.cash_value) /
          parseFloat(lastRecord.total_value)) *
        100
      ).toFixed(2),
    },
  ];

  for (const symbol of targetCoins) {
    const price = marketData[symbol].get(lastDateStr);
    const val = holdings[symbol] * price;
    const pct = (val / parseFloat(lastRecord.total_value)) * 100;
    if (pct > 1)
      finalPositions.push({
        symbol: symbol.replace("USDT", ""),
        percentage: pct.toFixed(2),
        avg_price: (costBasis[symbol] / holdings[symbol]).toFixed(4),
      });
  }
  await supabase.from("current_positions").insert(finalPositions);

  // --- KESIMPULAN AKHIR ---
  const finalValue = parseFloat(lastRecord.total_value);
  const totalROI = parseFloat(lastRecord.system_roi);
  const finalBTCROI = parseFloat(lastRecord.btc_roi);
  const finalSPXROI = parseFloat(lastRecord.spx_roi);

  console.log(
    `\n╔════════════════════════════════════════════════════════════╗`,
  );
  console.log(`║          🏆 HASIL AKHIR BACKTEST (QUANT GOLD)              ║`);
  console.log(`╠════════════════════════════════════════════════════════════╣`);
  console.log(`   💰 Modal Awal          : $10,000.00                        `);
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
