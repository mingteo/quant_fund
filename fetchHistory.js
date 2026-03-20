require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// Inisialisasi Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

// 1. TENTUKAN KERANJANG KOIN (Bisa kamu tambah/kurangi sesuai selera)
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

// Fungsi jeda (delay) agar API Bybit tidak menganggap kita melakukan Spam / DDoS
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function setupAndFetchHistory() {
  console.log("🛠️ MEMULAI SETUP ASET & PENARIKAN DATA (1000 HARI)...");

  try {
    // LANGKAH 1: Daftarkan Koin ke Tabel 'assets' jika belum ada
    console.log("\n[1/3] Mendaftarkan keranjang koin ke database...");
    for (const symbol of targetCoins) {
      const { error } = await supabase
        .from("assets")
        .upsert({ symbol: symbol, is_active: true }, { onConflict: "symbol" });

      if (error) {
        console.error(`Gagal mendaftarkan ${symbol}:`, error.message);
      } else {
        console.log(`- ${symbol} terdaftar.`);
      }
    }

    // LANGKAH 2: Ambil ID aset (UUID) dari database untuk relasi data
    console.log("\n[2/3] Mengambil ID Aset...");
    const { data: assets, error: assetError } = await supabase
      .from("assets")
      .select("id, symbol")
      .in("symbol", targetCoins);

    if (assetError) throw assetError;

    // LANGKAH 3: Tarik Sejarah Harga 1000 Hari per Koin dari Bybit
    console.log("\n[3/3] Menyedot data historis dari Bybit...");
    for (const asset of assets) {
      console.log(`\n⏳ Mengunduh riwayat ${asset.symbol}...`);

      const bybitUrl = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${asset.symbol}&interval=D&limit=1000`;

      const response = await fetch(bybitUrl);
      const jsonResponse = await response.json();

      if (jsonResponse.retCode !== 0) {
        console.error(
          `❌ Gagal menarik data ${asset.symbol}:`,
          jsonResponse.retMsg,
        );
        continue;
      }

      const rawKlines = jsonResponse.result.list;

      // Format data menyesuaikan skema tabel market_data
      const formattedData = rawKlines.map((candle) => ({
        asset_id: asset.id,
        timestamp: new Date(parseInt(candle[0])).toISOString(),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        timeframe: "1d",
      }));

      // Kirim data batch ke Supabase
      const { error: insertError } = await supabase
        .from("market_data")
        .upsert(formattedData, {
          onConflict: "asset_id, timestamp, timeframe",
        });

      if (insertError) {
        console.error(
          `❌ Gagal menyimpan ${asset.symbol}:`,
          insertError.message,
        );
      } else {
        console.log(`✅ SUKSES! 1000 hari ${asset.symbol} berhasil ditanam.`);
      }

      // Jeda 500 milidetik sebelum lanjut ke koin berikutnya
      await delay(500);
    }

    console.log("\n🎉 SELURUH DATA BIG CAP SIAP UNTUK MESIN PERINGKAT!");
  } catch (err) {
    console.error("Terjadi kesalahan sistem:", err);
  }
}

setupAndFetchHistory();
