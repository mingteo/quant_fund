require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY,
);
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: text,
      parse_mode: "Markdown",
    }),
  });
}

async function broadcastUpdate() {
  console.log("🤖 PREPARING QUANT ORACLE BROADCAST...");

  // 1. Ambil Performa Terakhir
  const { data: history } = await supabase
    .from("portfolio_history")
    .select("*")
    .order("date", { ascending: false })
    .limit(1);

  // 2. Ambil Posisi Koin Teratas
  const { data: positions } = await supabase
    .from("current_positions")
    .select("*")
    .order("percentage", { ascending: false });

  if (!history || history.length === 0) return;
  const last = history[0];

  // 3. Kalkulasi Risk Exposure
  const totalVal = parseFloat(last.total_value);
  const cashVal = parseFloat(last.cash_value);
  const cryptoVal = parseFloat(last.crypto_value);
  const cryptoExposurePct = ((cryptoVal / totalVal) * 100).toFixed(1);
  const cashExposurePct = ((cashVal / totalVal) * 100).toFixed(1);

  // Visualisasi Bar Eksposur (10 kotak)
  const filledBoxes = Math.round(cryptoExposurePct / 10);
  const exposureBar = "🟩".repeat(filledBoxes) + "⬜".repeat(10 - filledBoxes);

  // 4. Susun Pesan Telegram
  let message = `🏛 *QUANT ORACLE TERMINAL*\n`;
  message += `_Daily Execution: ${new Date().toLocaleString("id-ID")}_\n\n`;

  // SEGMEN 1: RISK EXPOSURE (Agresivitas Sistem)
  message += `🛡️ *SYSTEM EXPOSURE*\n`;
  message += `[${exposureBar}] *${cryptoExposurePct}%*\n`;
  message += `• Crypto Assets: *$${cryptoVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n`;
  message += `• Cash Reserve : *$${cashVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n\n`;

  // SEGMEN 2: EQUITY SUMMARY
  message += `💰 *EQUITY & PERFORMANCE*\n`;
  message += `• Total Capital: *$${totalVal.toLocaleString(undefined, { minimumFractionDigits: 2 })}*\n`;
  message += `• System ROI : *${last.system_roi}%*\n`;
  message += `• Max Drawdown: \`${last.max_drawdown}%\`\n\n`;

  // SEGMEN 3: SMART MONEY ALLOCATIONS
  message += `📊 *ACTIVE ALLOCATIONS*\n`;
  let hasCrypto = false;
  positions.forEach((p) => {
    if (p.symbol === "USDT") return; // Skip USDT karena sudah ada di Segmen Exposure
    hasCrypto = true;

    // Identifikasi jika alokasi sangat agresif (Whale Target)
    const isWhaleTarget = parseFloat(p.percentage) > 20 ? "🐋" : "⚡";
    message += `${isWhaleTarget} *${p.symbol}*: ${p.percentage}% _(@ $${parseFloat(p.avg_price).toLocaleString(undefined, { maximumFractionDigits: 4 })})_\n`;
  });

  if (!hasCrypto) {
    message += `⚠️ _100% CASH MODE ACTIVE (Awaiting Macro Clear)_\n`;
  }

  // SEGMEN 4: ALPHA GENERATION
  message += `\n📈 *ALPHA (VS BENCHMARK)*\n`;
  message += `• System : ${last.system_roi}%\n`;
  message += `• Bitcoin: ${last.btc_roi}%\n`;
  message += `• S&P 500: ${last.spx_roi}%\n\n`;

  const alpha = parseFloat(last.system_roi) - parseFloat(last.btc_roi);
  const status =
    alpha > 0
      ? `✅ BEATING MARKET BY +${alpha.toFixed(2)}%`
      : `⚠️ UNDERPERFORMING BTC BY ${alpha.toFixed(2)}%`;

  message += `*STATUS:* ${status}\n\n`;
  message += `🔗 [Dashboard Link](https://your-dashboard-url.vercel.app/)`;

  await sendTelegram(message);
  console.log("✅ BROADCAST SENT!");
}

broadcastUpdate();
