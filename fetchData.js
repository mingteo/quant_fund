require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// Inisialisasi Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

async function syncBybitData() {
  console.log("Memulai sinkronisasi data dari Bybit...");

  try {
    // 1. Ambil daftar koin yang aktif dari database
    const { data: assets, error: assetError } = await supabase
      .from("assets")
      .select("id, symbol")
      .eq("is_active", true);

    if (assetError) throw assetError;
    if (!assets || assets.length === 0) {
      console.log("Tidak ada aset aktif di database.");
      return;
    }

    // 2. Looping untuk setiap koin (misal: BTCUSDT)
    for (const asset of assets) {
      console.log(`Menarik data untuk ${asset.symbol}...`);

      // Endpoint Bybit V5 (Klines/Candles) - Kategori Spot, Interval D (Harian), Ambil 200 hari terakhir
      const bybitUrl = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${asset.symbol}&interval=D&limit=200`;

      const response = await fetch(bybitUrl);
      const jsonResponse = await response.json();

      if (jsonResponse.retCode !== 0) {
        console.error(
          `Gagal menarik data ${asset.symbol}:`,
          jsonResponse.retMsg,
        );
        continue;
      }

      // Bybit mengembalikan array of arrays: [startTime, openPrice, highPrice, lowPrice, closePrice, volume, turnover]
      const rawKlines = jsonResponse.result.list;

      // 3. Format data agar sesuai dengan struktur tabel market_data
      const formattedData = rawKlines.map((candle) => ({
        asset_id: asset.id,
        // Konversi timestamp milidetik ke ISO format untuk PostgreSQL
        timestamp: new Date(parseInt(candle[0])).toISOString(),
        open: parseFloat(candle[1]),
        high: parseFloat(candle[2]),
        low: parseFloat(candle[3]),
        close: parseFloat(candle[4]),
        volume: parseFloat(candle[5]),
        timeframe: "1d",
      }));

      // 4. Suntik data ke Supabase menggunakan upsert
      // Upsert akan melakukan Insert, tapi jika data di waktu yang sama sudah ada, dia akan melakukan Update
      const { error: insertError } = await supabase
        .from("market_data")
        .upsert(formattedData, {
          onConflict: "asset_id, timestamp, timeframe",
        });

      if (insertError) {
        console.error(
          `Gagal menyimpan data ${asset.symbol} ke Supabase:`,
          insertError.message,
        );
      } else {
        console.log(
          `Sukses menyimpan ${formattedData.length} baris data ${asset.symbol}.`,
        );
      }
    }

    console.log("Sinkronisasi selesai!");
  } catch (err) {
    console.error("Terjadi kesalahan sistem:", err);
  }
}

// Jalankan fungsi
syncBybitData();
