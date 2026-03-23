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
    .select("timestamp")
    .eq("asset_id", assetMap.get("BTCUSDT"))
    .order("timestamp", { ascending: true });

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
  const startBTCPrice = marketData["BTCUSDT"].get(
    btcTimeline[startIdx].timestamp,
  );
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

    // TAHAP 2: KOMPAS MAKRO & EXPOSURE
    const btcEma20 = calculateEMA(btcPrices.slice(-100), 20);
    const btcEma50 = calculateEMA(btcPrices.slice(-100), 50);
    const trendDirection = btcEma20 > btcEma50 ? "BULLISH" : "BEARISH";
    const regime =
      Math.abs((btcEma20 - btcEma50) / btcEma50) * 100 < 2 ? "MR" : "TREND";
    const mayer = currentBTCPrice / calculateSMA(btcPrices, 200);

    let targetExposure = 0;
    if (trendDirection === "BULLISH") {
      if (mayer < 1.1) targetExposure = 0.9;
      else if (mayer < 1.7) targetExposure = 0.7;
      else if (mayer < 2.4) targetExposure = 0.4;
      else targetExposure = 0.1;
    } else {
      targetExposure = regime === "MR" ? 0.2 : 0.0;
    }

    let alerts = [];
    const availableDXY = dxyTimeline
      .filter((d) => d.dateOnly <= dateOnly)
      .map((d) => d.close);
    if (availableDXY.length > 50) {
      if (
        calculateEMA(availableDXY.slice(-100), 20) >
        calculateEMA(availableDXY.slice(-100), 50)
      ) {
        targetExposure *= 0.5;
        alerts.push("DXY UPTREND");
      }
    }

    // TAHAP 3: RANKING MOMENTUM
    let dailyMomentum = [];
    for (const symbol of targetCoins) {
      const prices = getPricesUpToToday(symbol);
      if (prices.length < 50) continue;
      const isUptrend =
        calculateEMA(prices.slice(-100), 20) >
        calculateEMA(prices.slice(-100), 50);
      const roc14 = calculateROC(prices, 14);
      if (isUptrend && roc14 > 0) {
        dailyMomentum.push({ symbol, momentum: roc14 });
      }
    }
    dailyMomentum.sort((a, b) => b.momentum - a.momentum);
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
        `📈 Market: ${regime} (${trendDirection}) | Mayer: ${mayer.toFixed(2)}x`,
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
