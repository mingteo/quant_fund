require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

// --- 1. FUNGSI NOTIFIKASI TELEGRAM ---
async function sendTelegramUpdate(status, message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const text = `${status === "success" ? "✅" : "❌"} *SYSTEM NOTIFICATION*\n\n${message}\n\n🕒 _${new Date().toLocaleString("id-ID")}_`;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: text,
        parse_mode: "Markdown",
      }),
    });
  } catch (err) {
    console.error("Gagal kirim log ke Telegram:", err.message);
  }
}

const crypto = require("crypto"); // Built-in Node.js, tidak perlu install npm lagi

async function setupAndFetchHistory() {
  console.log("🛠️ MEMULAI PENARIKAN DATA DENGAN AUTH BYBIT...");

  const assets = [
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
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;

  const { data: dbAssets } = await supabase.from("assets").select("id, symbol");
  const assetMap = new Map(dbAssets.map((a) => [a.symbol, a.id]));

  for (const symbol of assets) {
    const assetId = assetMap.get(symbol);
    if (!assetId) continue;

    console.log(`⏳ Authenticated Fetching: ${symbol}...`);

    // --- LOGIKA SIGNATURE BYBIT V5 ---
    const timestamp = Date.now().toString();
    const recvWindow = "5000";
    const category = "spot";
    const interval = "D";
    const limit = "1000";

    // Urutan Query String harus benar untuk Signature
    const queryString = `category=${category}&interval=${interval}&limit=${limit}&symbol=${symbol}`;

    // Rumus Tanda Tangan: timestamp + apiKey + recvWindow + queryString
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(timestamp + apiKey + recvWindow + queryString)
      .digest("hex");

    const url = `https://api.bybit.com/v5/market/kline?${queryString}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
          "User-Agent": "MingQuantOracle/1.0",
        },
      });

      const json = await response.json();

      if (json.retCode !== 0) {
        console.error(`❌ Bybit API Error ${symbol}: ${json.retMsg}`);
        continue;
      }

      const klines = json.result?.list;
      if (!klines || klines.length === 0) continue;

      const formatted = klines.map((k) => ({
        asset_id: assetId,
        timestamp: new Date(parseInt(k[0])).toISOString(),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
      }));

      const { error: upsertError } = await supabase
        .from("market_data")
        .upsert(formatted, { onConflict: "asset_id, timestamp" });

      if (upsertError) console.error(`❌ DB Error: ${upsertError.message}`);
      else console.log(`✅ Success: ${formatted.length} rows for ${symbol}`);
    } catch (err) {
      console.error(`💥 Error: ${err.message}`);
    }

    await new Promise((res) => setTimeout(res, 1000)); // Safety delay
  }
}

setupAndFetchHistory();
