require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// --- 1. FUNGSI MATEMATIKA ---
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

// --- 2. MESIN WAKTU (VERSI EMAS + SHIDA LOG) ---
async function runBacktest() {
  console.log("Membangkitkan Versi Emas dengan Shida-Style Logging...");

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

  const { data: btcDerivatives } = await supabase
    .from("derivatives_data")
    .select("timestamp, funding_rate")
    .eq("symbol", "BTCUSDT")
    .order("timestamp", { ascending: true });
  let derivMap = new Map();
  if (btcDerivatives) {
    btcDerivatives.forEach((item) =>
      derivMap.set(
        new Date(item.timestamp).toISOString().split("T")[0],
        parseFloat(item.funding_rate),
      ),
    );
  }

  const { data: dxyData } = await supabase
    .from("macro_data")
    .select("timestamp, close")
    .eq("symbol", "DXY")
    .order("timestamp", { ascending: true });
  let dxyTimeline = [];
  if (dxyData) {
    dxyTimeline = dxyData.map((item) => ({
      dateOnly: new Date(item.timestamp).toISOString().split("T")[0],
      close: parseFloat(item.close),
    }));
  }

  const { data: btcTimeline } = await supabase
    .from("market_data")
    .select("timestamp")
    .eq("asset_id", assetMap.get("BTCUSDT"))
    .order("timestamp", { ascending: true });

  // [BARU] Ambil data SPX
  const { data: spxData } = await supabase
    .from("macro_data")
    .select("timestamp, close")
    .eq("symbol", "SPX")
    .order("timestamp", { ascending: true });
  let spxTimeline = [];
  if (spxData) {
    spxTimeline = spxData.map((item) => ({
      dateOnly: new Date(item.timestamp).toISOString().split("T")[0],
      close: parseFloat(item.close),
    }));
  }

  let capitalUSDT = 10000;
  let holdings = {};
  targetCoins.forEach((coin) => (holdings[coin] = 0));
  let peakPortfolioValue = 10000;
  let maxDrawdown = 0;
  let totalTrades = 0;

  // [BARU] Inisialisasi rekam jejak harian & harga awal
  let dailyRecords = [];
  const startDateStr = btcTimeline[200] ? btcTimeline[200].timestamp : null;
  const startBTCPrice = startDateStr ? marketData["BTCUSDT"].get(startDateStr) : 0;
  const startDateOnly = startDateStr ? new Date(startDateStr).toISOString().split("T")[0] : "2000-01-01";
  const startSPXPrice = spxTimeline.find((d) => d.dateOnly >= startDateOnly)?.close || 1;

  for (let i = 200; i < btcTimeline.length; i++) {
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

    // --- TAHAP 1: KOMPAS MAKRO & EXPOSURE ---
    const btcEma20 = calculateEMA(btcPrices.slice(-100), 20);
    const btcEma50 = calculateEMA(btcPrices.slice(-100), 50);
    const trendDirection = btcEma20 > btcEma50 ? "BULLISH" : "BEARISH";
    const regime =
      Math.abs((btcEma20 - btcEma50) / btcEma50) * 100 < 2 ? "MR" : "TREND";
    const mayer = currentBTCPrice / calculateSMA(btcPrices, 200);

    let targetExposure = 0;
    if (regime === "TREND" && trendDirection === "BULLISH") {
      if (mayer < 0.8) targetExposure = 1.0;
      else if (mayer >= 0.8 && mayer < 1.5) targetExposure = 0.8;
      else if (mayer >= 1.5 && mayer < 2.4) targetExposure = 0.5;
    } else if (regime === "MR") {
      targetExposure = 0.3;
    }

    let alerts = [];
    // Rem Makro DXY
    const availableDXY = dxyTimeline
      .filter((d) => d.dateOnly <= dateOnly)
      .map((d) => d.close);
    if (availableDXY.length > 50) {
      if (
        calculateEMA(availableDXY.slice(-100), 20) >
        calculateEMA(availableDXY.slice(-100), 50)
      ) {
        targetExposure *= 0.5;
        alerts.push("[🚨 DXY UPTREND]");
      }
    }
    // Filter Funding Rate
    if (derivMap.has(dateOnly)) {
      const fr = derivMap.get(dateOnly);
      if (fr > 0.0005) {
        targetExposure *= 0.7;
        alerts.push("[⚠️ HIGH FR]");
      }
    }

    // --- TAHAP 2: RANKING MOMENTUM ---
    let dailyMomentum = [];
    let currentPortfolioValue = capitalUSDT;

    for (const symbol of targetCoins) {
      const prices = getPricesUpToToday(symbol);
      if (prices.length < 50) continue;
      const currentPrice = prices[prices.length - 1];
      currentPortfolioValue += holdings[symbol] * currentPrice;

      const isUptrend =
        calculateEMA(prices.slice(-100), 20) >
        calculateEMA(prices.slice(-100), 50);
      const roc14 = calculateROC(prices, 14);

      if (isUptrend && roc14 > 0) {
        dailyMomentum.push({ symbol, momentum: roc14, price: currentPrice });
      }
    }

    dailyMomentum.sort((a, b) => b.momentum - a.momentum);
    const topSymbols = dailyMomentum.slice(0, 3).map((c) => c.symbol);

    // --- TAHAP 3: REBALANCING & LOGGING ---
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
      const difference = targetVal - currentVal;

      if (Math.abs(difference) > 50) {
        if (difference > 0) {
          capitalUSDT -= difference;
          holdings[symbol] += difference / currentPrice;
          actionLog.push(`+${symbol.replace("USDT", "")}`);
        } else {
          capitalUSDT += Math.abs(difference);
          holdings[symbol] -= Math.abs(difference) / currentPrice;
          actionLog.push(`-${symbol.replace("USDT", "")}`);
        }
        dayHasTrades = true;
        totalTrades++;
      }
    }

    // --- CETAK LOG GAYA SHIDA ---
    if (dayHasTrades) {
      console.log(`\n=========================================`);
      console.log(`🗓️ [${dateOnly}] TWX PORTFOLIO UPDATE`);
      if (alerts.length > 0) console.log(`Alerts: ${alerts.join(" | ")}`);
      console.log(`Market Regime: ${regime} (${trendDirection})`);
      console.log(`Aksi Sistem : ${actionLog.join(", ")}`);
      console.log(`\nCurrent Holdings:`);

      for (const symbol of targetCoins) {
        const currentPrice = marketData[symbol]?.get(todayStr);
        const currentVal = holdings[symbol] * currentPrice;
        const percentage = (currentVal / currentPortfolioValue) * 100;
        if (percentage > 1) {
          console.log(
            `${percentage.toFixed(0)}% Spot $${symbol.replace("USDT", "")}\t($${currentPrice.toFixed(2)})`,
          );
        }
      }
      const cashPercentage = (capitalUSDT / currentPortfolioValue) * 100;
      console.log(`${cashPercentage.toFixed(0)}% Cash (USDT)`);
      console.log(`=========================================`);
    }

    if (currentPortfolioValue > peakPortfolioValue)
      peakPortfolioValue = currentPortfolioValue;
    const currentDrawdown =
      ((peakPortfolioValue - currentPortfolioValue) / peakPortfolioValue) * 100;
    if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;

    // --- [BARU] REKAM JEJAK HARIAN UNTUK DATABASE ---
    const currentSystemROI = ((currentPortfolioValue - 10000) / 10000) * 100;
    const currentBTCROI = ((currentBTCPrice - startBTCPrice) / startBTCPrice) * 100;

    // Cari harga SPX hari ini (atau harga terakhir yang ada jika weekend)
    const availableSPX = spxTimeline
      .filter((d) => d.dateOnly <= dateOnly)
      .map((d) => d.close);
    const currentSPXPrice =
      availableSPX.length > 0 ? availableSPX[availableSPX.length - 1] : startSPXPrice;
    const currentSPXROI = ((currentSPXPrice - startSPXPrice) / startSPXPrice) * 100;

    dailyRecords.push({
      date: dateOnly,
      total_value: currentPortfolioValue.toFixed(2),
      cash_value: capitalUSDT.toFixed(2),
      crypto_value: (currentPortfolioValue - capitalUSDT).toFixed(2),
      system_roi: currentSystemROI.toFixed(2),
      btc_roi: currentBTCROI.toFixed(2),
      spx_roi: currentSPXROI.toFixed(2),
    });
  }

  // KESIMPULAN AKHIR
  let finalCryptoValue = 0;
  const lastDateStr = btcTimeline[btcTimeline.length - 1].timestamp;
  for (const symbol of targetCoins) {
    if (holdings[symbol] > 0 && marketData[symbol].has(lastDateStr)) {
      finalCryptoValue +=
        holdings[symbol] * marketData[symbol].get(lastDateStr);
    }
  }

  const finalValue = capitalUSDT + finalCryptoValue;
  const totalROI = ((finalValue - 10000) / 10000) * 100;

  console.log(`\n=========================================`);
  console.log(`🏆 HASIL BACKTEST (MACRO-RANKING ENGINE)`);
  console.log(`=========================================`);
  console.log(`Modal Awal         : $10,000.00`);
  console.log(`Nilai Akhir        : $${finalValue.toFixed(2)}`);
  console.log(`Return Sistem (ROI): ${totalROI.toFixed(2)}%`);
  console.log(`Max Drawdown       : -${maxDrawdown.toFixed(2)}%`);
  console.log(`=========================================`);

  // --- [BARU] MENGIRIM DATA KE SUPABASE ---
  console.log(`\n⏳ Mengirim ${dailyRecords.length} hari rekam jejak ke Supabase...`);

  // Supabase memiliki batas payload, kita pecah (chunk) pengiriman per 500 hari
  const chunkSize = 500;
  for (let i = 0; i < dailyRecords.length; i += chunkSize) {
    const chunk = dailyRecords.slice(i, i + chunkSize);
    const { error } = await supabase
      .from("portfolio_history")
      .upsert(chunk, { onConflict: "date" });

    if (error) {
      console.error("❌ Gagal menyimpan rekam jejak:", error.message);
    }
  }
  console.log(`✅ SUKSES! Rekam jejak portofolio berhasil ditanam di database.`);
}

runBacktest();
