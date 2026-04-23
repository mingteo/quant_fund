require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// Gunakan Service Role Key untuk operasi Backend agar tidak terhalang RLS
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY,
);
const CC_API_KEY = process.env.CC_API_KEY;

// ====================================================================
// 1. FUNGSI PENCATATAN AUDIT LOG (TRADE HISTORY)
// ====================================================================
// Penambahan parameter `executionTime` agar waktu dipaksa secara eksternal
async function recordTrade(symbol, type, price, amount, pnl, executionTime) {
  const { error } = await supabase.from("trade_history").insert([
    {
      symbol: symbol,
      type: type,
      exit_price: price,
      amount: amount,
      pnl_percent: pnl,
      pnl_value: type === "SELL" ? price * amount * (pnl / 100) : 0,
      timestamp: executionTime, // <-- WAKTU SERVER REAL-TIME
    },
  ]);

  if (error)
    console.error(`❌ Gagal mencatat audit ${type} ${symbol}:`, error.message);
  else
    console.log(`✅ Audit tercatat: ${type} ${symbol} pada ${executionTime}`);
}

// ====================================================================
// 2. FUNGSI SINKRONISASI HARGA (CRYPTOCOMPARE)
// ====================================================================
async function setupAndFetchHistory() {
  console.log("🛠️ MEMULAI PENARIKAN DATA VIA CRYPTOCOMPARE...");
  const assets = [
    "BTC",
    "ETH",
    "SOL",
    "SUI",
    "BNB",
    "XRP",
    "DOGE",
    "AVAX",
    "LINK",
    "HYPE",
    "ZEC",
    "PAXG",
  ];

  const { data: dbAssets } = await supabase.from("assets").select("id, symbol");
  const assetMap = new Map(
    dbAssets.map((a) => [a.symbol.replace("USDT", ""), a.id]),
  );

  for (const symbol of assets) {
    const assetId = assetMap.get(symbol);
    if (!assetId) continue;

    console.log(`⏳ Fetching ${symbol}...`);
    const url = `https://min-api.cryptocompare.com/data/v2/histoday?fsym=${symbol}&tsym=USD&limit=1000&api_key=${CC_API_KEY}`;

    try {
      const response = await fetch(url);
      const json = await response.json();

      if (json.Response === "Error") {
        console.error(`❌ API Error ${symbol}: ${json.Message}`);
        continue;
      }

      const klines = json.Data.Data;
      const formatted = klines.map((k) => ({
        asset_id: assetId,
        timestamp: new Date(k.time * 1000).toISOString(),
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volumeto,
        timeframe: "1d",
      }));

      const { error: upsertError } = await supabase
        .from("market_data")
        .upsert(formatted, { onConflict: "asset_id, timestamp, timeframe" });

      if (upsertError) console.error(`❌ DB Error: ${upsertError.message}`);
      else console.log(`✅ Success: ${formatted.length} rows for ${symbol}`);
    } catch (err) {
      console.error(`💥 Fatal Error ${symbol}: ${err.message}`);
    }
    await new Promise((res) => setTimeout(res, 500));
  }
  console.log("🎉 SEMUA DATA TERSINKRON!");
}

// ====================================================================
// 3. ENGINE ALOKASI LIVE (HYSTERESIS & REALTIME TIMESTAMP FIX)
// ====================================================================
// Fungsi ini dipanggil SETELAH harga di-update.
async function executeLiveRebalancing(
  targetValues,
  currentHoldings,
  marketPrices,
  capitalUSDT,
) {
  console.log("\n🤖 MEMULAI ORACLE LIVE REBALANCING...");

  // WAKTU SERVER SAAT INI (REAL-TIME)
  const serverTimeMs = Date.now();

  // Hitung Total Equity untuk mencari batas toleransi
  let currentCryptoValue = 0;
  for (const [symbol, amount] of Object.entries(currentHoldings)) {
    currentCryptoValue += amount * (marketPrices[symbol] || 0);
  }
  const totalEquity = capitalUSDT + currentCryptoValue;

  // 🔥 HYSTERESIS THRESHOLD: 5% dari total portofolio
  // Sistem tidak akan mengeksekusi rotasi aset jika selisih nilai di bawah angka ini
  const rebalanceThreshold = totalEquity * 0.05;
  console.log(
    `🛡️ Hysteresis Aktif: Mengabaikan fluktuasi di bawah $${rebalanceThreshold.toFixed(2)}`,
  );

  let isSellExecuted = false;

  // --- FASE 1: EKSEKUSI SELL ---
  for (const symbol of Object.keys(targetValues)) {
    const currentPrice = marketPrices[symbol];
    if (!currentPrice) continue;

    const currentVal = currentHoldings[symbol] * currentPrice;
    const targetVal = targetValues[symbol];
    const diff = targetVal - currentVal;

    // SYARAT SELL: Kelebihan muatan melewati threshold ATAU koin terkena target exit 0
    if (diff < -rebalanceThreshold || (targetVal === 0 && currentVal > 10)) {
      const sellQty = Math.min(
        Math.abs(diff) / currentPrice,
        currentHoldings[symbol],
      );

      if (sellQty > 0) {
        const pnl_percent = 0; // Anda bisa mengkalkulasi PnL berdasarkan avg_price riil di sini

        // TIMESTAMP FIX 1: Gunakan waktu server detik ini persis
        const liveSellTime = new Date(serverTimeMs).toISOString();

        await recordTrade(
          symbol,
          "SELL",
          currentPrice,
          sellQty,
          pnl_percent,
          liveSellTime,
        );
        isSellExecuted = true;
      }
    }
  }

  // --- FASE 2: EKSEKUSI BUY ---
  for (const symbol of Object.keys(targetValues)) {
    const currentPrice = marketPrices[symbol];
    if (!currentPrice) continue;

    const currentVal = currentHoldings[symbol] * currentPrice;
    const targetVal = targetValues[symbol];
    const diff = targetVal - currentVal;

    // SYARAT BUY: Kekurangan muatan melewati threshold
    if (diff > rebalanceThreshold) {
      const buyAmount = Math.min(diff, capitalUSDT);

      if (buyAmount > 10) {
        // Abaikan dust transaction di bawah $10
        const buyQty = buyAmount / currentPrice;

        // TIMESTAMP FIX 2: Tambah 1.5 detik agar BUY selalu tercatat SETELAH SELL di database
        const delayMs = isSellExecuted ? 1500 : 0;
        const liveBuyTime = new Date(serverTimeMs + delayMs).toISOString();

        await recordTrade(symbol, "BUY", currentPrice, buyQty, 0, liveBuyTime);
      }
    }
  }
  console.log("✅ REBALANCING SELESAI!");
}

// ====================================================================
// MAIN RUNNER
// ====================================================================
async function runLiveBot() {
  // 1. Tarik Harga Terbaru
  await setupAndFetchHistory();

  // 2. DI SINI tempat Anda menjalankan kalkulasi Quant (mengambil data indikator untuk menentukan target)
  // ...

  // Contoh variabel yang harus dihasilkan oleh algoritma Anda sebelum dieksekusi:
  // const targetValues = { "BTCUSDT": 5000, "SOLUSDT": 3000, "ETHUSDT": 0 };
  // const currentHoldings = { "BTCUSDT": 0.05, "SOLUSDT": 10, "ETHUSDT": 0.5 };
  // const marketPrices = { "BTCUSDT": 95000, "SOLUSDT": 150, "ETHUSDT": 3000 };
  // const capitalUSDT = 2000;

  // 3. Eksekusi Live Alokasi
  // await executeLiveRebalancing(targetValues, currentHoldings, marketPrices, capitalUSDT);
}

runLiveBot();
