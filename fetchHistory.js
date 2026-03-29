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

const crypto = require("crypto");

async function setupAndFetchHistory() {
  console.log("🛠️ MEMULAI PENARIKAN DATA (REVISI SIGNATURE V5)...");

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

    const timestamp = Date.now().toString();
    const recvWindow = "5000";

    // PENTING: Urutan parameter harus Alfabetis untuk beberapa endpoint Bybit
    // Dan jangan ada spasi!
    const category = "spot";
    const interval = "D";
    const limit = "1000";

    // String untuk Signature (tanpa tanda tanya ?)
    const rawQueryString = `category=${category}&interval=${interval}&limit=${limit}&symbol=${symbol}`;

    // Rumus Signature V5: timestamp + apiKey + recvWindow + rawQueryString
    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(timestamp + apiKey + recvWindow + rawQueryString)
      .digest("hex");

    // URL lengkap dengan query string
    const url = `https://api.bytick.com/v5/market/kline?${rawQueryString}`;

    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
          // HEADER INI SANGAT PENTING UNTUK BYPASS CLOUDFLARE
          Connection: "keep-alive",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
          Accept: "*/*",
          "Accept-Encoding": "gzip, deflate, br",
          "Cache-Control": "no-cache",
        },
      });

      // Cek apakah response-nya benar-benar JSON
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        const errorBody = await response.text();
        console.error(
          `❌ Non-JSON Response for ${symbol}. Status: ${response.status}`,
        );
        // Jika kena limit atau blokir, biasanya muncul di sini
        continue;
      }

      const json = await response.json();

      if (json.retCode !== 0) {
        console.error(
          `❌ Bybit API Error ${symbol}: ${json.retMsg} (Code: ${json.retCode})`,
        );
        continue;
      }

      const klines = json.result?.list;
      if (!klines || klines.length === 0) {
        console.warn(`⚠️ No data for ${symbol}`);
        continue;
      }

      const formatted = klines.map((k) => ({
        asset_id: assetId,
        timestamp: new Date(parseInt(k[0])).toISOString(),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        volume: parseFloat(k[5]),
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

    await new Promise((res) => setTimeout(res, 1000));
  }
}
setupAndFetchHistory();
