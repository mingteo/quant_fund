require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);
const CC_API_KEY = process.env.CC_API_KEY;

// Contoh logika sederhana untuk mencatat penjualan
async function recordTrade(symbol, type, price, amount, pnl = 0) {
  const { data, error } = await supabase.from("trade_history").insert([
    {
      symbol: symbol,
      type: type,
      exit_price: price,
      amount: amount,
      pnl_percent: pnl,
      timestamp: executionTime,
    },
  ]);
  if (error) console.error("Gagal mencatat audit:", error);
}

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

    // CryptoCompare API: Ambil 1000 hari terakhir
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
        volume: k.volumeto, // Volume dalam USD
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

setupAndFetchHistory();
