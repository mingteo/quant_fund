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

// --- 2. FUNGSI UTAMA FETCH ---
async function setupAndFetchHistory() {
  console.log("🛠️ MEMULAI PENARIKAN DATA...");

  // INI YANG TADI HILANG: Definisi daftar koin
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

  let successCount = 0;
  let failCount = 0;

  try {
    // Pastikan tabel assets di Supabase sudah sinkron dengan list di atas
    const { data: dbAssets, error: assetError } = await supabase
      .from("assets")
      .select("id, symbol");

    if (assetError || !dbAssets) {
      throw new Error("Gagal mengambil daftar assets dari database Supabase.");
    }

    const assetMap = new Map(dbAssets.map((a) => [a.symbol, a.id]));

    for (const symbol of assets) {
      const assetId = assetMap.get(symbol);
      if (!assetId) {
        console.warn(
          `⚠️ Skip ${symbol}: Tidak terdaftar di tabel assets Supabase.`,
        );
        failCount++;
        continue;
      }

      console.log(`⏳ Fetching ${symbol} (ID: ${assetId})...`);

      // Gunakan api.bytick.com (lebih tahan blokir GitHub)
      const url = `https://api.bytick.com/v5/market/kline?category=spot&symbol=${symbol}&interval=D&limit=1000`;

      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
          Accept: "application/json",
        },
      });

      if (!response.ok) {
        console.error(`❌ Error ${symbol}: HTTP ${response.status}`);
        failCount++;
        continue;
      }

      const json = await response.json();
      const klines = json.result?.list;

      if (!klines || klines.length === 0) {
        console.warn(`⚠️ Data ${symbol} kosong dari Bybit.`);
        failCount++;
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
      }));

      const { error: upsertError } = await supabase
        .from("market_data")
        .upsert(formatted, { onConflict: "asset_id, timestamp" });

      if (upsertError) {
        console.error(`❌ DB Error ${symbol}:`, upsertError.message);
        failCount++;
      } else {
        console.log(`✅ Success: ${formatted.length} rows for ${symbol}`);
        successCount++;
      }

      await delay(1000); // Jeda anti-spam
    }

    // KIRIM NOTIFIKASI SUKSES
    await sendTelegramUpdate(
      "success",
      `*DATABASE SYNC COMPLETE*\n` +
        `📦 Assets Synced: ${successCount}\n` +
        `⚠️ Failed/Skipped: ${failCount}\n\n` +
        `🚀 _Data market siap diproses Backtest Engine._`,
    );
  } catch (err) {
    console.error("💥 Critical System Error:", err.message);
    await sendTelegramUpdate(
      "error",
      `*CRITICAL FETCH ERROR*\nMessage: ${err.message}`,
    );
  }
}

setupAndFetchHistory();
