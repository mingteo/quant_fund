require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

async function fetchDerivatives() {
  console.log("🔥 MEMULAI PENARIKAN DATA DERIVATIF (AUTH BYBIT V5)...");

  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  const apiKey = process.env.BYBIT_API_KEY;
  const apiSecret = process.env.BYBIT_API_SECRET;

  for (const symbol of symbols) {
    console.log(`⏳ Menarik data likuiditas untuk ${symbol}...`);

    const timestamp = Date.now().toString();
    const recvWindow = "5000";

    // Endpoint Open Interest & Funding Rate Bybit V5
    // Kita ambil data terbaru saja (limit 1)
    const queryString = `category=linear&symbol=${symbol}&limit=1`;

    const signature = crypto
      .createHmac("sha256", apiSecret)
      .update(timestamp + apiKey + recvWindow + queryString)
      .digest("hex");

    // URL untuk Open Interest (Kita gunakan ini sebagai proksi likuiditas)
    const url = `https://api.bybit.com/v5/market/open-interest?${queryString}`;

    try {
      const response = await fetch(url, {
        headers: {
          "X-BAPI-API-KEY": apiKey,
          "X-BAPI-SIGN": signature,
          "X-BAPI-TIMESTAMP": timestamp,
          "X-BAPI-RECV-WINDOW": recvWindow,
          "User-Agent": "Mozilla/5.0",
        },
      });

      const text = await response.text();

      // Safety Check: Jika kena blokir HTML lagi
      if (text.startsWith("<!DOCTYPE")) {
        console.error(
          `❌ Cloudflare Block on ${symbol} (403). Masih terdeteksi sebagai bot.`,
        );
        continue;
      }

      const json = JSON.parse(text);

      if (json.retCode !== 0) {
        console.error(`❌ Bybit API Error: ${json.retMsg}`);
        continue;
      }

      const data = json.result.list[0];

      // Simpan ke tabel derivatives_data (Pastikan tabel ini sudah ada di Supabase)
      const { error: dbError } = await supabase.from("derivatives_data").upsert(
        {
          symbol: symbol,
          open_interest: parseFloat(data.openInterest),
          timestamp: new Date().toISOString(),
        },
        { onConflict: "symbol" },
      );

      if (dbError) console.error(`❌ DB Error ${symbol}:`, dbError.message);
      else console.log(`✅ ${symbol} OI: ${data.openInterest} Synced.`);
    } catch (err) {
      console.error(`💥 Fatal Error ${symbol}:`, err.message);
    }

    await new Promise((res) => setTimeout(res, 1000));
  }
}

fetchDerivatives();
