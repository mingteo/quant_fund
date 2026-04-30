require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

async function fetchDerivatives() {
  console.log("🔥 FETCHING REAL OPEN INTEREST VIA OKX...");

  // Format OKX wajib memakai tanda hubung dan berakhiran SWAP
  const symbols = [
    "BTC-USDT-SWAP",
    "ETH-USDT-SWAP",
    "SOL-USDT-SWAP",
    "SUI-USDT-SWAP",
    "BNB-USDT-SWAP",
    "XRP-USDT-SWAP",
    "DOGE-USDT-SWAP",
    "AVAX-USDT-SWAP",
    "LINK-USDT-SWAP",
    "HYPE-USDT-SWAP",
    "ZEC-USDT-SWAP",
  ];

  for (const symbol of symbols) {
    console.log(`⏳ Syncing OI & FR for ${symbol}...`);

    const oiUrl = `https://www.okx.com/api/v5/public/open-interest?instId=${symbol}`;
    const frUrl = `https://www.okx.com/api/v5/public/funding-rate?instId=${symbol}`;

    try {
      // Tarik 2 data secara bersamaan
      const [oiRes, frRes] = await Promise.all([fetch(oiUrl), fetch(frUrl)]);
      const oiJson = await oiRes.json();
      const frJson = await frRes.json();

      if (
        oiJson.code === "0" &&
        oiJson.data.length > 0 &&
        frJson.code === "0" &&
        frJson.data.length > 0
      ) {
        const oiValue = parseFloat(oiJson.data[0].oi);
        const frValue = parseFloat(frJson.data[0].fundingRate); // Ini angka desimal murni, misal 0.0001

        const cleanSymbol = symbol.split("-")[0] + "USDT";

        const { error } = await supabase.from("derivatives_data").insert({
          symbol: cleanSymbol,
          open_interest: oiValue,
          funding_rate: frValue,
          timestamp: new Date().toISOString(),
        });

        if (error) console.error(`❌ Supabase Error: ${error.message}`);
        else
          console.log(
            `✅ ${cleanSymbol} | OI: ${oiValue.toLocaleString()} | FR: ${frValue} Synced!`,
          );
      } else {
        console.log(`⚠️ Data tidak lengkap di OKX untuk ${symbol}`);
      }
    } catch (err) {
      console.error(`💥 Error: ${err.message}`);
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
}

fetchDerivatives();
