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
  console.log("🤖 PREPARING TELEGRAM BROADCAST...");

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

  // 3. Susun Pesan
  let message = `🏛 *QUANT ORACLE TERMINAL*\n`;
  message += `_Update: ${new Date().toLocaleString("id-ID")}_\n\n`;

  message += `💰 *EQUITY SUMMARY*\n`;
  message += `• Total Value: *$${parseFloat(last.total_value).toLocaleString()}*\n`;
  message += `• System ROI: *${last.system_roi}%*\n`;
  message += `• Max Drawdown: \`${last.max_drawdown}%\`\n\n`;

  message += `📊 *TOP ALLOCATIONS*\n`;
  positions.slice(0, 5).forEach((p) => {
    const icon = p.symbol === "USDT" ? "💵" : "🚀";
    message += `${icon} ${p.symbol}: ${p.percentage}% ${p.avg_price ? `_(@$${p.avg_price})_` : ""}\n`;
  });

  message += `\n📈 *BENCHMARK VS SYSTEM*\n`;
  message += `• System : ${last.system_roi}%\n`;
  message += `• Bitcoin: ${last.btc_roi}%\n`;
  message += `• S&P 500: ${last.spx_roi}%\n\n`;

  const status =
    parseFloat(last.system_roi) > parseFloat(last.btc_roi)
      ? "✅ OUTPERFORMING BTC"
      : "⚠️ UNDERPERFORMING BTC";
  message += `*STATUS:* ${status}\n\n`;
  message += `🔗 [View Full Dashboard](https://your-dashboard-url.vercel.app/)`;

  await sendTelegram(message);
  console.log("✅ BROADCAST SENT!");
}

broadcastUpdate();
