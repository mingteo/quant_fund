require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

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
  "PAXGUSDT",
];

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function setupAndFetchHistory() {
  console.log("🛠️  MEMULAI PENARIKAN DATA UNTUK GITHUB ACTIONS...");

  try {
    // LANGKAH 1 & 2: Registrasi & Ambil ID
    const { data: assets, error: assetError } = await supabase
      .from("assets")
      .select("id, symbol")
      .in("symbol", targetCoins);

    if (assetError) throw assetError;

    // LANGKAH 3: Tarik Data dengan Header Keamanan
    for (const asset of assets) {
      console.log(`⏳ Processing ${asset.symbol}...`);

      const bybitUrl = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${asset.symbol}&interval=D&limit=1000`;

      try {
        const response = await fetch(bybitUrl, {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            // PENTING: User-Agent mencegah blokir IP GitHub
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
          },
        });

        if (!response.ok) {
          console.error(`❌ HTTP Error ${asset.symbol}: ${response.status}`);
          continue;
        }

        const jsonResponse = await response.json();

        if (jsonResponse.retCode !== 0) {
          console.error(`❌ Bybit Error ${asset.symbol}:`, jsonResponse.retMsg);
          continue;
        }

        const rawKlines = jsonResponse.result.list;
        if (!rawKlines || rawKlines.length === 0) continue;

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

        // UPSERT KE SUPABASE
        const { error: insertError } = await supabase
          .from("market_data")
          .upsert(formattedData, {
            onConflict: "asset_id, timestamp, timeframe",
          });

        if (insertError) {
          console.error(
            `❌ Supabase Error ${asset.symbol}:`,
            insertError.message,
          );
        } else {
          console.log(
            `✅ ${asset.symbol}: ${formattedData.length} data points synced.`,
          );
        }
      } catch (innerErr) {
        console.error(
          `💥 Connection Failed for ${asset.symbol}:`,
          innerErr.message,
        );
      }

      // Jeda 1 detik (Lebih aman untuk GitHub Actions)
      await delay(1000);
    }

    console.log("\n🎉 SYNC SELESAI!");
  } catch (err) {
    console.error("Critical System Error:", err);
  }
}

setupAndFetchHistory();
