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
  console.log("🛠️  STARTING ROBUST SYNC FOR GITHUB ACTIONS...");

  try {
    // LANGKAH 1: Pastikan semua koin terdaftar di tabel assets
    console.log("Checking & Registering Assets...");
    for (const symbol of targetCoins) {
      await supabase
        .from("assets")
        .upsert({ symbol: symbol }, { onConflict: "symbol" });
    }

    // LANGKAH 2: Ambil ID Assets terbaru
    const { data: assets, error: assetError } = await supabase
      .from("assets")
      .select("id, symbol")
      .in("symbol", targetCoins);

    if (assetError || !assets || assets.length === 0) {
      throw new Error(
        "Assets not found in database. Check your 'assets' table.",
      );
    }

    console.log(`Found ${assets.length} assets. Starting data pull...`);

    // LANGKAH 3: Tarik Sejarah per Koin
    for (const asset of assets) {
      console.log(`⏳ Fetching ${asset.symbol}...`);
      let formattedData = [];

      try {
        const binanceOnly = ["ZECUSDT", "PAXGUSDT"];
        let useBinance = binanceOnly.includes(asset.symbol);
        
        if (!useBinance) {
          const bybitUrl = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${asset.symbol}&interval=D&limit=1000`;
          const response = await fetch(bybitUrl, {
            headers: { "User-Agent": "Mozilla/5.0" },
          });
          const json = await response.json();

          if (
            json.retCode === 0 &&
            json.result.list &&
            json.result.list.length > 0
          ) {
            // Check if data is stale (oldest candle is more than 3 days old)
            // Bybit returns newest first, so list[0] is the newest
            const newestTimestamp = parseInt(json.result.list[0][0]);
            const isStale = (Date.now() - newestTimestamp) > 3 * 24 * 60 * 60 * 1000;
            
            if (!isStale) {
              formattedData = json.result.list.map((c) => ({
                asset_id: asset.id,
                timestamp: new Date(parseInt(c[0])).toISOString(),
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                volume: parseFloat(c[5]),
                timeframe: "1d",
              }));
            } else {
              console.log(`⚠️ Bybit data for ${asset.symbol} is stale. Trying Binance...`);
              useBinance = true;
            }
          } else {
            console.log(`⚠️ Bybit returned no valid data for ${asset.symbol}. Trying Binance...`);
            useBinance = true;
          }
        }

        if (useBinance) {
          const binanceUrl = `https://api.binance.com/api/v3/klines?symbol=${asset.symbol}&interval=1d&limit=1000`;
          const binanceRes = await fetch(binanceUrl);
          const binanceData = await binanceRes.json();

          if (Array.isArray(binanceData) && binanceData.length > 0) {
            formattedData = binanceData.map((c) => ({
              asset_id: asset.id,
              timestamp: new Date(parseInt(c[0])).toISOString(),
              open: parseFloat(c[1]),
              high: parseFloat(c[2]),
              low: parseFloat(c[3]),
              close: parseFloat(c[4]),
              volume: parseFloat(c[5]),
              timeframe: "1d",
            }));
          } else {
            console.error(`❌ Both Bybit and Binance failed for ${asset.symbol}`);
            continue;
          }
        }

        // PENTING: Kirim dalam potongan kecil (Chunking) agar tidak timeout di GitHub
        const chunkSize = 200;
        for (let i = 0; i < formattedData.length; i += chunkSize) {
          const chunk = formattedData.slice(i, i + chunkSize);
          const { error: upsertError } = await supabase
            .from("market_data")
            .upsert(chunk, { onConflict: "asset_id, timestamp, timeframe" });

          if (upsertError) {
            console.error(
              `❌ Upsert error for ${asset.symbol}: ${upsertError.message}`,
            );
          }
        }

        console.log(`✅ ${asset.symbol} Synced (${formattedData.length} rows)`);
      } catch (err) {
        console.error(`💥 Failed fetching ${asset.symbol}:`, err.message);
      }

      await delay(1000); // Anti-spam delay
    }

    console.log("\n🚀 DATABASE SYNC COMPLETE!");
  } catch (err) {
    console.error("CRITICAL ERROR:", err.message);
    process.exit(1); // Beri sinyal gagal ke GitHub Actions
  }
}

setupAndFetchHistory();
