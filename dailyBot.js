require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- FUNGSI MATEMATIKA ---
function calculateEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  const k = 2 / (period + 1);
  let ema = prices[0];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}
function calculateSMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1] || 0;
  return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
}
function calculateROC(prices, period) {
  if (prices.length <= period) return 0;
  const current = prices[prices.length - 1];
  const past = prices[prices.length - 1 - period];
  return ((current - past) / past) * 100;
}

// --- MAIN FUNCTION ---
async function generateDailyReport() {
  console.log("Menganalisis kondisi pasar hari ini...");

  const targetCoins = [
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
  ];
  const { data: assets } = await supabase
    .from("assets")
    .select("id, symbol")
    .in("symbol", targetCoins);
  const assetMap = new Map(assets.map((a) => [a.symbol, a.id]));

  // Tarik 100 hari data terakhir untuk kalkulasi EMA & ROC
  let marketData = {};
  for (const symbol of targetCoins) {
    const assetId = assetMap.get(symbol);
    const { data } = await supabase
      .from("market_data")
      .select("close")
      .eq("asset_id", assetId)
      .order("timestamp", { ascending: false })
      .limit(200); // Tarik descending, lalu reverse
    marketData[symbol] = data.map((d) => parseFloat(d.close)).reverse();
  }

  const btcPrices = marketData["BTCUSDT"];
  const currentBTCPrice = btcPrices[btcPrices.length - 1];

  // 1. MACRO & REGIME BTC
  const ema20BTC = calculateEMA(btcPrices.slice(-100), 20);
  const ema50BTC = calculateEMA(btcPrices.slice(-100), 50);
  const regime =
    Math.abs((ema20BTC - ema50BTC) / ema50BTC) * 100 < 2
      ? "MEAN-REVERTING"
      : "TRENDING";
  const trendDirection = ema20BTC > ema50BTC ? "BULLISH" : "BEARISH";

  // 2. MOMENTUM RANKING (Mencari 2 Koin Terkuat untuk "Higher Beta Position")
  let momentumRanking = [];
  for (const symbol of targetCoins) {
    if (symbol === "BTCUSDT") continue; // BTC tidak masuk altcoin ranking
    const prices = marketData[symbol];
    const roc14 = calculateROC(prices, 14);
    const isUptrend =
      calculateEMA(prices.slice(-100), 20) >
      calculateEMA(prices.slice(-100), 50);

    if (isUptrend && roc14 > 0) {
      momentumRanking.push({
        symbol: symbol.replace("USDT", ""),
        momentum: roc14,
      });
    }
  }
  momentumRanking.sort((a, b) => b.momentum - a.momentum);
  const topAlts = momentumRanking.slice(0, 2);
  const topAltsString =
    topAlts.length > 0
      ? topAlts.map((a) => `$${a.symbol}`).join(", ")
      : "None (No Momentum)";

  // 3. TARGET EXPOSURE
  const mayer = currentBTCPrice / calculateSMA(btcPrices, 200);
  let targetExposure = 0;
  if (regime === "TRENDING" && trendDirection === "BULLISH") {
    if (mayer < 0.8) targetExposure = 1.0;
    else if (mayer >= 0.8 && mayer < 1.5) targetExposure = 0.8;
    else if (mayer >= 1.5 && mayer < 2.4) targetExposure = 0.5;
    else targetExposure = 0.0;
  } else if (regime === "MEAN-REVERTING") {
    targetExposure = 0.3;
  }

  // 4. DATA ASOSIASI (Derivatif & Makro - Ambil 1 hari terakhir dari DB)
  let associatedData = [];
  const { data: derivData } = await supabase
    .from("derivatives_data")
    .select("funding_rate")
    .eq("symbol", "BTCUSDT")
    .order("timestamp", { ascending: false })
    .limit(1);
  if (derivData && derivData.length > 0) {
    const fr = parseFloat(derivData[0].funding_rate);
    if (fr > 0.0005) {
      associatedData.push("High Leverage (Longs) detected. Risk of flush.");
      targetExposure *= 0.7;
    } else if (fr < -0.0001) {
      associatedData.push("Negative FR detected. Short Squeeze potential.");
      targetExposure = Math.min(1.0, targetExposure + 0.2);
    }
  }

  const { data: dxyData } = await supabase
    .from("macro_data")
    .select("close")
    .eq("symbol", "DXY")
    .order("timestamp", { ascending: false })
    .limit(50);
  if (dxyData && dxyData.length >= 50) {
    const dxyPrices = dxyData.map((d) => parseFloat(d.close)).reverse();
    if (calculateEMA(dxyPrices, 20) > calculateEMA(dxyPrices, 50)) {
      associatedData.push("DXY in Uptrend (Risk-Off global environment).");
      targetExposure *= 0.5;
    } else {
      associatedData.push(
        "DXY in Downtrend (Supportive liquidity environment).",
      );
    }
  }

  if (associatedData.length === 0)
    associatedData.push("Market conditions normal. No extreme anomalies.");

  // --- PEMFORMATAN PESAN GAYA SHIDA ---
  const dateStr = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const cryptoPct = (targetExposure * 100).toFixed(0);
  const cashPct = (100 - cryptoPct).toFixed(0);

  const message = `
🤖 *${dateStr} - QUANT ORACLE System Update*

*Bias & Momentum Update:*
Market Dominant Major: $BTC
Optional Higher Beta Position: ${topAltsString}
Optional Denominator: USDT (Cash)

*BTC Market Regime Update:*
REGIME in ${regime} state (${trendDirection})

*QUANT ORACLE PORTFOLIO TARGET*
Current Target Holdings:
${cryptoPct}% Spot Crypto 
${cashPct}% Cash (USDT)

*Associated Data:*
${associatedData.join("\n")}
  `.trim();

  console.log(message);

  // --- KIRIM KE TELEGRAM ---
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "Markdown",
      }),
    });
    const result = await response.json();
    if (result.ok) {
      console.log("\n✅ Berhasil mengirim laporan harian ke Telegram!");
    } else {
      console.error("\n❌ Gagal mengirim ke Telegram:", result.description);
    }
  } catch (error) {
    console.error("Error API Telegram:", error);
  }
}

generateDailyReport();
