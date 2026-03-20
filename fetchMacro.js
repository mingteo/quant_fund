require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

// Inisialisasi Yahoo Finance V3
const YahooFinance = require("yahoo-finance2").default;
const yahooFinance = new YahooFinance();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

async function fetchMacroData() {
  console.log("🌍 MEMULAI PENARIKAN DATA MAKRO GLOBAL...");

  // Simbol di Yahoo Finance: DX-Y.NYB (Indeks Dolar AS), ^GSPC (S&P 500)
  const macroAssets = [
    { symbol: "DXY", yfSymbol: "DX-Y.NYB" },
    { symbol: "SPX", yfSymbol: "^GSPC" },
  ];

  // Set tanggal mulai (3 tahun lalu) dan tanggal akhir (hari ini)
  const period2 = new Date(); // Hari ini
  const period1 = new Date();
  period1.setFullYear(period2.getFullYear() - 3); // Mundur 3 tahun

  try {
    for (const asset of macroAssets) {
      console.log(
        `\nMenarik data historis untuk ${asset.symbol} dari Yahoo Finance...`,
      );

      const queryOptions = {
        period1: period1,
        period2: period2,
        interval: "1d",
      };

      // Menggunakan fungsi .chart() sesuai aturan baru Yahoo Finance
      const result = await yahooFinance.chart(asset.yfSymbol, queryOptions);
      const quotes = result.quotes; // Data array ada di dalam properti 'quotes'

      console.log(
        `Berhasil mendapat ${quotes.length} hari data ${asset.symbol}. Menyimpan ke Supabase...`,
      );

      // Kita filter(d => d.close !== null) karena Yahoo kadang memberikan data 'null' saat libur bursa
      const formattedData = quotes
        .filter((day) => day.close !== null && day.close !== undefined)
        .map((day) => ({
          symbol: asset.symbol,
          timestamp: new Date(day.date).toISOString(),
          close: day.close,
        }));

      // Proses upsert batch
      const { error } = await supabase
        .from("macro_data")
        .upsert(formattedData, { onConflict: "symbol, timestamp" });

      if (error) {
        console.error(`❌ Gagal menyimpan ${asset.symbol}:`, error.message);
      } else {
        console.log(
          `✅ SUKSES! Data historis ${asset.symbol} berhasil ditanam.`,
        );
      }
    }
    console.log("\nDATABASE MAKRO SIAP DIGUNAKAN!");
  } catch (err) {
    console.error("Terjadi kesalahan sistem:", err);
  }
}

fetchMacroData();
