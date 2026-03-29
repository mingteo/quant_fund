require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

async function fetchDerivatives() {
  console.log("🔥 FETCHING OPEN INTEREST VIA BINANCE PUBLIC (NO-AUTH)...");

  // Daftar koin yang ingin dipantau OI-nya
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

  for (const symbol of symbols) {
    console.log(`⏳ Getting Binance OI for ${symbol}...`);

    // Binance Futures Public API - Open Interest Statistics
    // Parameter: symbol, period (5m, 1h, 1d)
    const url = `https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=1`;

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
        },
      });

      if (!response.ok) {
        console.error(`❌ Binance Error ${symbol}: HTTP ${response.status}`);
        continue;
      }

      const data = await response.json();

      if (!data || data.length === 0) {
        console.warn(`⚠️ No data returned for ${symbol}`);
        continue;
      }

      // Ambil data terbaru (index 0)
      const latest = data[0];
      const sumOpenInterest = parseFloat(latest.sumOpenInterest);

      const { error: dbError } = await supabase.from("derivatives_data").upsert(
        {
          symbol: symbol,
          open_interest: sumOpenInterest,
          timestamp: new Date().toISOString(),
        },
        { onConflict: "symbol" },
      );

      if (dbError) console.error(`❌ DB Error ${symbol}:`, dbError.message);
      else
        console.log(
          `✅ ${symbol} OI: ${sumOpenInterest.toLocaleString()} Synced.`,
        );
    } catch (err) {
      console.error(`💥 Fatal Error ${symbol}:`, err.message);
    }

    // Jeda sebentar agar tidak kena rate limit
    await new Promise((res) => setTimeout(res, 1000));
  }
}

fetchDerivatives();
