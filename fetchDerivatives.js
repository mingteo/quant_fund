require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

async function fetchDerivatives() {
  console.log(
    "🔥 FETCHING OPEN INTEREST VIA MEXC PUBLIC (BYPASS REGULATION)...",
  );

  const symbols = ["BTC_USDT", "ETH_USDT", "SOL_USDT"]; // Format MEXC pakai underscore

  for (const symbol of symbols) {
    console.log(`⏳ Getting MEXC OI for ${symbol}...`);

    // MEXC Futures Public API - Open Interest
    const url = `https://contract.mexc.com/api/v1/contract/open_interest?symbol=${symbol}`;

    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0",
        },
      });

      const json = await response.json();

      if (json.code !== 200 || !json.data) {
        console.error(`❌ MEXC Error ${symbol}: ${json.msg || "No Data"}`);
        continue;
      }

      // Ambil nilai Open Interest
      const openInterest = parseFloat(json.data.openInterest);
      const cleanSymbol = symbol.replace("_", ""); // Kembalikan ke format BTCUSDT

      const { error: dbError } = await supabase.from("derivatives_data").upsert(
        {
          symbol: cleanSymbol,
          open_interest: openInterest,
          timestamp: new Date().toISOString(),
        },
        { onConflict: "symbol" },
      );

      if (dbError) console.error(`❌ DB Error ${symbol}:`, dbError.message);
      else
        console.log(
          `✅ ${cleanSymbol} OI: ${openInterest.toLocaleString()} Synced from MEXC.`,
        );
    } catch (err) {
      console.error(`💥 Fatal Error ${symbol}:`, err.message);
    }

    await new Promise((res) => setTimeout(res, 1000));
  }
}

fetchDerivatives();
