require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

const targetCoins = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "SUIUSDT"]; // Kita fokus ke penggerak pasar utama
const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function fetchDerivatives() {
  console.log(
    "🔥 MEMULAI PENARIKAN DATA DERIVATIF (FUNDING RATE & OPEN INTEREST)...",
  );

  try {
    for (const symbol of targetCoins) {
      console.log(`\nMenarik data likuiditas untuk ${symbol}...`);

      // 1. Tarik History Funding Rate dari Bybit (Linear/Futures Market)
      const frUrl = `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${symbol}&limit=200`;
      const frResponse = await fetch(frUrl);
      const frJson = await frResponse.json();

      // 2. Tarik Open Interest saat ini (Bybit API gratis membatasi historical OI yang panjang,
      // jadi kita ambil snapshot interval harian untuk hari ini dan beberapa hari ke belakang)
      const oiUrl = `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${symbol}&intervalTime=1d&limit=200`;
      const oiResponse = await fetch(oiUrl);
      const oiJson = await oiResponse.json();

      if (frJson.retCode !== 0 || oiJson.retCode !== 0) {
        console.error(
          `❌ Gagal menarik data ${symbol}. FR: ${frJson.retMsg}, OI: ${oiJson.retMsg}`,
        );
        continue;
      }

      const frList = frJson.result.list; // Array of funding rates
      const oiList = oiJson.result.list; // Array of open interest

      // Sinkronisasi data berdasarkan Timestamp (Harian)
      let derivativesMap = new Map();

      // Masukkan Funding Rate ke Map
      frList.forEach((item) => {
        // Bybit FR biasanya per 8 jam, kita ambil tanggalnya saja untuk di-map ke harian
        const dateStr = new Date(parseInt(item.fundingRateTimestamp))
          .toISOString()
          .split("T")[0];
        // Kita ambil rata-rata atau nilai terakhir di hari itu. Untuk simpel, kita ambil data pertama yang terbaca di tanggal tsb
        if (!derivativesMap.has(dateStr)) {
          derivativesMap.set(dateStr, {
            symbol: symbol,
            timestamp: new Date(dateStr).toISOString(),
            funding_rate: parseFloat(item.fundingRate),
            open_interest: 0, // Default, akan diisi dari list OI
          });
        }
      });

      // Masukkan Open Interest ke Map yang sama
      oiList.forEach((item) => {
        const dateStr = new Date(parseInt(item.timestamp))
          .toISOString()
          .split("T")[0];
        if (derivativesMap.has(dateStr)) {
          let dataPoint = derivativesMap.get(dateStr);
          dataPoint.open_interest = parseFloat(item.openInterest);
          derivativesMap.set(dateStr, dataPoint);
        }
      });

      // Konversi Map ke Array untuk dimasukkan ke Supabase
      const formattedData = Array.from(derivativesMap.values()).filter(
        (d) => d.open_interest > 0,
      );

      // Simpan ke Supabase
      const { error } = await supabase
        .from("derivatives_data")
        .upsert(formattedData, { onConflict: "symbol, timestamp" });

      if (error) {
        console.error(
          `❌ Gagal menyimpan data derivatif ${symbol}:`,
          error.message,
        );
      } else {
        console.log(
          `✅ SUKSES! ${formattedData.length} baris data likuiditas ${symbol} disimpan.`,
        );
      }

      await delay(500);
    }

    console.log("\nDATABASE DERIVATIF SIAP DIGUNAKAN!");
  } catch (error) {
    console.error("Terjadi kesalahan:", error);
  }
}

fetchDerivatives();
