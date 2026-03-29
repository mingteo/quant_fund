require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

async function fetchDerivatives() {
  console.log("🔥 FETCHING REAL OPEN INTEREST VIA OKX...");

  // Format OKX: BTC-USDT-SWAP
  const symbols = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP"];

  for (const symbol of symbols) {
    console.log(`⏳ Syncing OI for ${symbol}...`);

    // Endpoint khusus Open Interest OKX
    const url = `https://www.okx.com/api/v5/public/open-interest?instId=${symbol}`;

    try {
      const response = await fetch(url);
      const json = await response.json();

      if (json.code === "0" && json.data.length > 0) {
        const oiValue = parseFloat(json.data[0].oi);
        const cleanSymbol = symbol.split("-")[0] + "USDT";

        const { error } = await supabase.from("derivatives_data").upsert(
          {
            symbol: cleanSymbol,
            open_interest: oiValue,
            timestamp: new Date().toISOString(),
          },
          { onConflict: "symbol" },
        );

        if (error) console.error(`❌ Supabase Error: ${error.message}`);
        else
          console.log(
            `✅ ${cleanSymbol} OI: ${oiValue.toLocaleString()} Synced!`,
          );
      }
    } catch (err) {
      console.error(`💥 Error: ${err.message}`);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}

fetchDerivatives();
