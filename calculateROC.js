require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

async function analyzeMomentum(symbol) {
  try {
    // 1. Cari ID Asset berdasarkan symbol
    const { data: assetData } = await supabase
      .from("assets")
      .select("id")
      .eq("symbol", symbol)
      .single();

    if (!assetData) return console.log("Aset tidak ditemukan.");

    // 2. Tarik data dari market_data, urutkan dari yang terbaru, ambil 5 data terakhir
    const { data: candles, error } = await supabase
      .from("market_data")
      .select("close, timestamp")
      .eq("asset_id", assetData.id)
      .order("timestamp", { ascending: false })
      .limit(5);

    if (error) throw error;
    if (candles.length < 5)
      return console.log("Data belum cukup untuk dihitung.");

    // 3. Implementasi Rumus ROC
    const currentClose = parseFloat(candles[0].close); // Harga hari ini (paling atas)
    const pastClose = parseFloat(candles[4].close); // Harga 5 hari yang lalu (paling bawah di array)

    const rocValue = ((currentClose - pastClose) / pastClose) * 100;

    // 4. Menerjemahkan Angka menjadi "State" (Seperti di Dashboard Shida)
    let state = "Neutral";
    if (rocValue > 5) {
      state = "Bullish State (+ROC)";
    } else if (rocValue > 0 && rocValue <= 5) {
      state = "Slight Bullish (+ROC)";
    } else if (rocValue < -5) {
      state = "Bearish State (-ROC)";
    } else if (rocValue < 0 && rocValue >= -5) {
      state = "Slight Bearish (-ROC)";
    }

    console.log(`=== ANALISIS MOMENTUM ${symbol} ===`);
    console.log(`Harga 5 Hari Lalu : $${pastClose}`);
    console.log(`Harga Hari Ini    : $${currentClose}`);
    console.log(`Nilai ROC         : ${rocValue.toFixed(2)}%`);
    console.log(`Kesimpulan Sistem : ${state}`);
    console.log(`===================================`);
  } catch (err) {
    console.error("Error saat menganalisis:", err);
  }
}

// Jalankan fungsi untuk BTCUSDT
analyzeMomentum("BTCUSDT");
