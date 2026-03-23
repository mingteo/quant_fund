require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- 1. FUNGSI MATEMATIKA ---
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

// --- 2. MAIN FUNCTION ---
async function generateDailyReport() {
  console.log("🛠️  Mengonstruksi Laporan Kuantitatif...");

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
  ];

  const { data: assets } = await supabase
    .from("assets")
    .select("id, symbol")
    .in("symbol", targetCoins);
  const assetMap = new Map(assets.map((a) => [a.symbol, a.id]));

  // Tarik Data Harga
  let marketData = {};
  for (const symbol of targetCoins) {
    const assetId = assetMap.get(symbol);
    const { data } = await supabase
      .from("market_data")
      .select("close")
      .eq("asset_id", assetId)
      .order("timestamp", { ascending: false })
      .limit(200);
    marketData[symbol] = data.map((d) => parseFloat(d.close)).reverse();
  }

  const btcPrices = marketData["BTCUSDT"];
  const currentBTCPrice = btcPrices[btcPrices.length - 1];

  // A. Analisis Regime & Trend
  const ema20BTC = calculateEMA(btcPrices.slice(-100), 20);
  const ema50BTC = calculateEMA(btcPrices.slice(-100), 50);
  const regime =
    Math.abs((ema20BTC - ema50BTC) / ema50BTC) * 100 < 2
      ? "MEAN-REVERTING"
      : "TRENDING";
  const trendDirection = ema20BTC > ema50BTC ? "BULLISH" : "BEARISH";
  const mayer = currentBTCPrice / calculateSMA(btcPrices, 200);

  // B. Momentum Ranking (Top 2 Alts)
  let momentumRanking = [];
  for (const symbol of targetCoins) {
    if (symbol === "BTCUSDT") continue;
    const prices = marketData[symbol];
    const roc14 = calculateROC(prices, 14);
    const isUptrend =
      calculateEMA(prices.slice(-100), 20) >
      calculateEMA(prices.slice(-100), 50);
    if (isUptrend && roc14 > 0)
      momentumRanking.push({
        symbol: symbol.replace("USDT", ""),
        momentum: roc14,
      });
  }
  momentumRanking.sort((a, b) => b.momentum - a.momentum);
  const topAltsString =
    momentumRanking
      .slice(0, 2)
      .map((a) => `$${a.symbol}`)
      .join(", ") || "None";

  // C. Data Makro (DXY)
  let associatedData = [];
  const { data: dxyRaw } = await supabase
    .from("macro_data")
    .select("close")
    .eq("symbol", "DXY")
    .order("timestamp", { ascending: false })
    .limit(50);
  if (dxyRaw) {
    const dxyPrices = dxyRaw.map((d) => parseFloat(d.close)).reverse();
    const dxyUp = calculateEMA(dxyPrices, 20) > calculateEMA(dxyPrices, 50);
    associatedData.push(
      dxyUp ? "DXY Uptrend (Risk-Off)" : "DXY Downtrend (Supportive)",
    );
  }

  // D. Ambil Posisi Real dari DB (Pie Chart Data)
  const { data: currentPositions } = await supabase
    .from("current_positions")
    .select("symbol, percentage")
    .order("percentage", { ascending: false });

  // --- 3. PEMFORMATAN PESAN ---
  const dateStr = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  // Hitung Exposure dari total posisi non-Cash
  const cryptoPct =
    currentPositions
      ?.filter((p) => p.symbol !== "USDT" && p.symbol !== "Cash (USDT)")
      .reduce((acc, curr) => acc + parseFloat(curr.percentage), 0) || 0;
  const progressBar =
    "▓".repeat(Math.round(cryptoPct / 10)) +
    "░".repeat(Math.round((100 - cryptoPct) / 10));

  let message = `*📊 QUANT ORACLE - DAILY REPORT*\n_${dateStr}_\n\n`;
  message += `*─ MARKET REGIME ─*\n`;
  message += `• *Status:* ${regime}\n`;
  message += `• *Trend:* ${trendDirection === "BULLISH" ? "📈 BULLISH" : "📉 BEARISH"}\n`;
  message += `• *Mayer:* ${mayer.toFixed(2)}x\n\n`;

  message += `*─ ALLOCATION ─*\n`;
  message += `*Exposure:* ${cryptoPct.toFixed(0)}% Crypto | ${(100 - cryptoPct).toFixed(0)}% Cash\n`;
  message += `\`${progressBar}\`\n\n`;

  message += `*─ CURRENT HOLDINGS ─*\n`;
  if (currentPositions && currentPositions.length > 0) {
    currentPositions.forEach((pos) => {
      const isCash = pos.symbol === "USDT" || pos.symbol === "Cash (USDT)";
      if (isCash) {
        message += `• *$USDT* : ${parseFloat(pos.percentage).toFixed(1)}% (Liquidity)\n`;
      } else {
        const symbolUSDT = `${pos.symbol}USDT`;
        const currentPrice = marketData[symbolUSDT]
          ? marketData[symbolUSDT][marketData[symbolUSDT].length - 1]
          : 0;

        // Ambil Avg Price dari DB
        const avgPrice = pos.avg_price
          ? parseFloat(pos.avg_price)
          : currentPrice;
        const pnl = ((currentPrice - avgPrice) / avgPrice) * 100;

        message += `• *$${pos.symbol.padEnd(5)}*: ${parseFloat(pos.percentage).toFixed(1)}%\n`;
        message += `  └ Avg: $${avgPrice.toLocaleString()} → Now: $${currentPrice.toLocaleString()}\n`;
        message += `  └ PnL: *${pnl >= 0 ? "🟢 +" : "🔴 "}${pnl.toFixed(2)}%*\n`;
      }
    });
  }

  message += `\n*─ RISK & MOMENTUM ─*\n`;
  message += `• *Top Momentum:* ${topAltsString}\n`;
  message += `• *Macro:* ${associatedData.join(" | ")}\n\n`;
  message += `_Generated by Oracle Quant Engine_`;

  // --- 4. KIRIM KE TELEGRAM ---
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
    if (result.ok) console.log("✅ Laporan terkirim!");
    else console.error("❌ Gagal:", result.description);
  } catch (error) {
    console.error("Error API:", error);
  }
}

generateDailyReport();
