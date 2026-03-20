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

// --- 2. MESIN WAKTU (CROSS-ASSET RANKING ENGINE) ---
async function runBacktest() {
  console.log("Menyiapkan Mesin Peringkat (Ranking Engine) untuk 11 Koin...");

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
  ];

  // A. Tarik ID Aset
  const { data: assets } = await supabase
    .from("assets")
    .select("id, symbol")
    .in("symbol", targetCoins);
  const assetMap = new Map(assets.map((a) => [a.symbol, a.id]));

  // B. Tarik Data Historis Semua Koin
  let marketData = {};
  for (const symbol of targetCoins) {
    const assetId = assetMap.get(symbol);
    if (!assetId) continue;

    const { data } = await supabase
      .from("market_data")
      .select("timestamp, close")
      .eq("asset_id", assetId)
      .order("timestamp", { ascending: true });

    // Simpan dalam format Map agar mudah dicari berdasarkan tanggal
    marketData[symbol] = new Map(
      data.map((item) => [item.timestamp, parseFloat(item.close)]),
    );
  }

  // C. Gunakan timeline BTC sebagai kalender utama
  const { data: btcTimeline } = await supabase
    .from("market_data")
    .select("timestamp")
    .eq("asset_id", assetMap.get("BTCUSDT"))
    .order("timestamp", { ascending: true });

  console.log(
    `Berhasil memuat data. Memulai simulasi rotasi brutal dari ${btcTimeline.length} hari...\n`,
  );

  // --- VARIABEL DOMPET (PORTFOLIO) ---
  let capitalUSDT = 10000;
  // Menyimpan jumlah koin yang dimiliki. Contoh: holdings['SOLUSDT'] = 15.5
  let holdings = {};
  targetCoins.forEach((coin) => (holdings[coin] = 0));

  let totalTrades = 0;
  let peakPortfolioValue = 10000;
  let maxDrawdown = 0;

  // 3. LOOPING HARIAN (Mulai dari hari ke-200)
  for (let i = 200; i < btcTimeline.length; i++) {
    const todayStr = btcTimeline[i].timestamp;
    const dateOnly = new Date(todayStr).toISOString().split("T")[0];

    // Fungsi kecil untuk mengekstrak array harga koin X dari awal sampai hari ini
    const getPricesUpToToday = (symbol) => {
      let prices = [];
      for (let j = 0; j <= i; j++) {
        const time = btcTimeline[j].timestamp;
        if (marketData[symbol].has(time)) {
          prices.push(marketData[symbol].get(time));
        }
      }
      return prices;
    };

    const btcPrices = getPricesUpToToday("BTCUSDT");
    if (btcPrices.length < 200) continue; // Skip jika data kurang

    const currentBTCPrice = btcPrices[btcPrices.length - 1];

    // --- TAHAP 1: KOMPAS MAKRO (Menentukan Porsi Kas vs Kripto) ---
    // Menggunakan BTC sebagai indikator kesehatan pasar global
    const ema20BTC = calculateEMA(btcPrices.slice(-100), 20);
    const ema50BTC = calculateEMA(btcPrices.slice(-100), 50);
    const regime =
      Math.abs((ema20BTC - ema50BTC) / ema50BTC) * 100 < 2 ? "MR" : "TREND";
    const trendDirection = ema20BTC > ema50BTC ? "Bullish" : "Bearish";

    const sma200BTC = calculateSMA(btcPrices, 200);
    const mayer = currentBTCPrice / sma200BTC;

    let cycleState = "Neutral";
    if (mayer < 0.8) cycleState = "DEEP OVERSOLD";
    else if (mayer >= 0.8 && mayer < 1.5) cycleState = "FAIR VALUE";
    else if (mayer >= 1.5 && mayer < 2.4) cycleState = "HEATING UP";
    else if (mayer >= 2.4) cycleState = "OVERBOUGHT";

    let targetExposure = 0; // Target modal untuk kripto
    if (regime === "TREND" && trendDirection === "Bullish") {
      if (cycleState === "DEEP OVERSOLD") targetExposure = 1.0;
      else if (cycleState === "FAIR VALUE") targetExposure = 0.8;
      else if (cycleState === "HEATING UP") targetExposure = 0.5;
      else targetExposure = 0.0;
    } else if (regime === "MR") {
      targetExposure = 0.3; // Sideways, kurangi risiko
    }

    // --- TAHAP 2: MESIN PERINGKAT (Mencari Koin Terkuat) ---
    let dailyMomentum = [];

    // Hitung valuasi portofolio saat ini untuk rebalancing nanti
    let currentPortfolioValue = capitalUSDT;

    for (const symbol of targetCoins) {
      const prices = getPricesUpToToday(symbol);
      if (prices.length < 50) continue;

      const currentPrice = prices[prices.length - 1];

      // Hitung total nilai koin yang sedang dipegang
      currentPortfolioValue += holdings[symbol] * currentPrice;

      // Filter: Koin harus dalam keadaan Uptrend (EMA 20 > EMA 50)
      const ema20 = calculateEMA(prices.slice(-100), 20);
      const ema50 = calculateEMA(prices.slice(-100), 50);
      const isUptrend = ema20 > ema50;

      // Hitung daya ledak (ROC 14 Hari)
      const roc14 = calculateROC(prices, 14);

      // Hanya masukkan koin yang trennya naik dan momentumnya positif
      if (isUptrend && roc14 > 0) {
        dailyMomentum.push({ symbol, momentum: roc14, price: currentPrice });
      }
    }

    // Urutkan dari yang paling buas ke yang paling lemah
    dailyMomentum.sort((a, b) => b.momentum - a.momentum);

    // Ambil Top 3 untuk memaksimalkan performa (Concentrated Portfolio)
    const topCoins = dailyMomentum.slice(0, 3);
    const topSymbols = topCoins.map((c) => c.symbol);

    // --- TAHAP 3: EKSEKUSI REBALANCING ---
    const totalCryptoBudget = currentPortfolioValue * targetExposure;
    // Bagi rata anggaran ke Top Koin yang lolos seleksi
    const budgetPerCoin =
      topCoins.length > 0 ? totalCryptoBudget / topCoins.length : 0;

    let dayHasTrades = false;
    let actionLog = [];

    for (const symbol of targetCoins) {
      const prices = getPricesUpToToday(symbol);
      const currentPrice = prices[prices.length - 1];
      const currentVal = holdings[symbol] * currentPrice;

      // Jika koin ini masuk Top 3, berikan jatah budget. Jika tidak, target budget-nya $0 (Jual Bersih)
      const targetVal = topSymbols.includes(symbol) ? budgetPerCoin : 0;
      const difference = targetVal - currentVal;

      // Threshold $50 agar tidak overtrading
      if (Math.abs(difference) > 50) {
        if (difference > 0) {
          capitalUSDT -= difference;
          holdings[symbol] += difference / currentPrice;
          actionLog.push(`+${symbol}`);
        } else {
          capitalUSDT += Math.abs(difference);
          holdings[symbol] -= Math.abs(difference) / currentPrice;
          actionLog.push(`-${symbol}`);
        }
        totalTrades++;
        dayHasTrades = true;
      }
    }

    if (dayHasTrades) {
      console.log(`\n=========================================`);
      console.log(`🗓️ [${dateOnly}] TWX PORTFOLIO UPDATE`);
      console.log(`Aksi Sistem : ${actionLog.join(", ")}`);
      console.log(`\nCurrent Holdings:\n`);

      // 1. Tampilkan porsi Kripto
      for (const symbol of targetCoins) {
        const currentPrice = getPricesUpToToday(symbol).pop();
        const currentVal = holdings[symbol] * currentPrice;
        const percentage = (currentVal / currentPortfolioValue) * 100;

        // Hanya cetak jika porsinya di atas 0.5% (mengabaikan debu/dust)
        if (percentage > 0.5) {
          const cleanSymbol = symbol.replace("USDT", ""); // Ubah 'BTCUSDT' jadi 'BTC'
          console.log(
            `${percentage.toFixed(0)}% Spot $${cleanSymbol}\t($${currentPrice.toFixed(2)})`,
          );
        }
      }

      // 2. Tampilkan porsi Kas (USDT)
      const cashPercentage = (capitalUSDT / currentPortfolioValue) * 100;
      if (cashPercentage > 0.5) {
        console.log(`${cashPercentage.toFixed(0)}% USDT\t\t($1.00)`);
      }
      console.log(`=========================================`);
    }

    // --- TRACKING DRAWDOWN ---
    if (currentPortfolioValue > peakPortfolioValue)
      peakPortfolioValue = currentPortfolioValue;
    const currentDrawdown =
      ((peakPortfolioValue - currentPortfolioValue) / peakPortfolioValue) * 100;
    if (currentDrawdown > maxDrawdown) maxDrawdown = currentDrawdown;
  }

  // --- KESIMPULAN AKHIR ---
  // Hitung nilai akhir dari sisa koin di hari terakhir
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
  console.log(`🏆 HASIL BACKTEST (CROSS-ASSET RANKING ENGINE)`);
  console.log(`=========================================`);
  console.log(`Koin Dipindai      : 11 Koin (Top 3 Allocation)`);
  console.log(`Modal Awal         : $10,000.00`);
  console.log(`Nilai Akhir        : $${finalValue.toFixed(2)}`);
  console.log(`Saldo USDT (Kas)   : $${capitalUSDT.toFixed(2)}`);
  console.log(`Total Aset Kripto  : $${finalCryptoValue.toFixed(2)}`);
  console.log(`Return Sistem (ROI): ${totalROI.toFixed(2)}%`);
  console.log(`-----------------------------------------`);
  console.log(`Max Drawdown       : -${maxDrawdown.toFixed(2)}%`);
  console.log(`Total Eksekusi     : ${totalTrades} kali rebalancing`);
  console.log(`=========================================`);
}

runBacktest();
