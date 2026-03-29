require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

async function fetchDerivatives() {
  console.log("🔥 FETCHING DERIVATIVES VIA OKX PUBLIC...");

  // OKX menggunakan format: BTC-USDT-SWAP
  const symbols = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"];

  for (const symbol of symbols) {
    console.log(`⏳ Getting OKX Data for ${symbol}...`);

    // OKX API V5 - Tickers (Memberikan Open Interest & Volume secara publik)
    const url = `https://www.okx.com/api/v5/market/ticker?instId=${symbol}`;

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0",
        },
      });

      const json = await response.json();

      if (json.code !== "0" || !json.data || json.data.length === 0) {
        console.error(`❌ OKX Error ${symbol}: ${json.msg || "No Data"}`);
        continue;
      }

      const data = json.data[0];
      // OKX tidak memberikan OI di ticker biasa, tapi kita bisa pakai 24h Volume
      // sebagai indikator 'Panas' tidaknya market derivatif.
      const vol24h = parseFloat(data.vol24h);
      const cleanSymbol = symbol.split("-")[0] + "USDT"; // Balik ke BTCUSDT

      const { error: dbError } = await supabase.from("derivatives_data").upsert(
        {
          symbol: cleanSymbol,
          open_interest: vol24h, // Kita simpan volume sebagai proxy 'panas' market
          timestamp: new Date().toISOString(),
        },
        { onConflict: "symbol" },
      );

      if (dbError) console.error(`❌ DB Error ${symbol}:`, dbError.message);
      else
        console.log(
          `✅ ${cleanSymbol} Activity: ${vol24h.toLocaleString()} Synced from OKX.`,
        );
    } catch (err) {
      console.error(`💥 Fatal Error ${symbol}:`, err.message);
    }

    await new Promise((res) => setTimeout(res, 1000));
  }
}

fetchDerivatives();
