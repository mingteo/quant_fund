require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// Fungsi pembantu untuk mengambil data dan menghitung ROC
async function getAssetROC(symbol, days = 5) {
  // 1. Cari ID Asset
  const { data: assetData } = await supabase
    .from("assets")
    .select("id")
    .eq("symbol", symbol)
    .single();

  if (!assetData)
    throw new Error(`Aset ${symbol} tidak ditemukan di database.`);

  // 2. Tarik harga penutupan (Close)
  const { data: candles, error } = await supabase
    .from("market_data")
    .select("close, timestamp")
    .eq("asset_id", assetData.id)
    .order("timestamp", { ascending: false })
    .limit(days);

  if (error) throw error;
  if (candles.length < days)
    throw new Error(`Data ${symbol} kurang dari ${days} hari.`);

  // 3. Hitung ROC
  const currentClose = parseFloat(candles[0].close);
  const pastClose = parseFloat(candles[candles.length - 1].close);
  const roc = ((currentClose - pastClose) / pastClose) * 100;

  return { currentClose, pastClose, roc };
}

// Fungsi Utama: Mengadu dua koin
async function compareAssets(symbolA, symbolB) {
  try {
    console.log(
      `Mengadu kekuatan: ${symbolA} vs ${symbolB} (Periode 5 Hari)...\n`,
    );

    const dataA = await getAssetROC(symbolA, 5);
    const dataB = await getAssetROC(symbolB, 5);

    console.log(`Performa ${symbolA}:`);
    console.log(`- Harga: $${dataA.pastClose} -> $${dataA.currentClose}`);
    console.log(`- ROC  : ${dataA.roc.toFixed(2)}%\n`);

    console.log(`Performa ${symbolB}:`);
    console.log(`- Harga: $${dataB.pastClose} -> $${dataB.currentClose}`);
    console.log(`- ROC  : ${dataB.roc.toFixed(2)}%\n`);

    // 4. Logika Penentu Bias
    let biasResult = "";

    if (dataA.roc > dataB.roc) {
      // Jika koin A menang (Naiknya lebih tinggi, atau turunnya lebih sedikit)
      biasResult = `${symbolA.replace("USDT", "")} Bias`;
    } else if (dataB.roc > dataA.roc) {
      // Jika koin B menang
      biasResult = `${symbolB.replace("USDT", "")} Bias`;
    } else {
      biasResult = "Neutral";
    }

    console.log(`=================================`);
    console.log(`KESIMPULAN SISTEM: ${biasResult}`);
    console.log(`=================================`);
  } catch (err) {
    console.error("Sistem error:", err.message);
  }
}

// Eksekusi pertarungan: BTC vs ETH
compareAssets("BTCUSDT", "ETHUSDT");
