const fs = require('fs');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
require('dotenv').config();

const groupJids = ['120363399532849287@g.us'];
const quoteLogPath = './usedQuotes.txt';

const fetchPrices = async () => {
  try {
    const res = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
      params: {
        ids: 'bitcoin,ethereum,solana',
        vs_currencies: 'usd',
        include_24hr_change: 'true'
      }
    });

    const data = res.data;

    return {
      BTC: {
        price: data.bitcoin.usd,
        change: data.bitcoin.usd_24h_change
      },
      ETH: {
        price: data.ethereum.usd,
        change: data.ethereum.usd_24h_change
      },
      SOL: {
        price: data.solana.usd,
        change: data.solana.usd_24h_change
      }
    };
  } catch (err) {
    console.error("❌ Error fetching prices from CoinGecko:", err.message);
    return {
      BTC: { price: 0, change: 0 },
      ETH: { price: 0, change: 0 },
      SOL: { price: 0, change: 0 }
    };
  }
};

const fetchFearGreedIndex = async () => {
  try {
    const response = await axios.get('https://api.alternative.me/fng/?limit=1');
    const data = response.data.data[0];
    return {
      value: data.value,
      sentiment: data.value_classification
    };
  } catch (err) {
    console.error("❌ Error fetching Fear & Greed Index:", err.message);
    return null;
  }
};

const fetchUniqueEnglishQuote = async () => {
  try {
    const response = await axios.get('https://favqs.com/api/qotd');
    const quote = response.data.quote.body;
    const author = response.data.quote.author || "Unknown";
    const quoteText = `_${quote}_\n— *${author}*`;

    const hash = Buffer.from(quote).toString('base64');
    let used = [];

    if (fs.existsSync(quoteLogPath)) {
      used = fs.readFileSync(quoteLogPath, 'utf8').split('\n').filter(Boolean);
    }

    if (used.includes(hash)) return null;

    used.push(hash);
    fs.writeFileSync(quoteLogPath, used.join('\n'));
    return quoteText;
  } catch (err) {
    console.error("❌ Error fetching quote:", err.message);
    return null;
  }
};

const startBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, qr } = update;
    if (qr) qrcode.generate(qr, { small: true });
    if (connection === 'open') console.log('✅ WhatsApp connected!');
    else if (connection === 'close') {
      console.log('❌ Connection closed. Reconnecting...');
      setTimeout(() => startBot(), 10000);
    }
  });

  // 💬 Group ID Reader: responds to "!groupid"
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !messages || !messages[0]?.message) return;

    const msg = messages[0];
    const from = msg.key.remoteJid;
    console.log(`📩 Message received from: ${from}`);

    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';
    if (text.trim().toLowerCase() === '!groupid') {
      const replyText = `👥 This group JID is:\n*${from}*`;
      await sock.sendMessage(from, { text: replyText });
      console.log(`📬 Sent group JID to: ${from}`);
    }
  });

  // ☀️ Morning Alert – 9:00 AM IST (3:30 AM UTC)
   cron.schedule('*/2 * * * *', async () => {
    try {
      const prices = await fetchPrices();
      const fng = await fetchFearGreedIndex();
      const quote = await fetchUniqueEnglishQuote();

      const sentimentValue = fng ? `${fng.value}%` : 'N/A';
      const sentimentLabel = fng?.sentiment || 'Neutral';
      const emoji = sentimentLabel.includes('Greed') ? '🟢' : sentimentLabel.includes('Fear') ? '🔴' : '⚪️';

      const now = new Date();
      const dateStr = now.toLocaleDateString('en-IN', {
        weekday: 'short',
        day: '2-digit',
        month: 'short'
      });

      const coins = [
        { name: 'BTC', emoji: '💹', ...prices.BTC },
        { name: 'ETH', emoji: '💣', ...prices.ETH },
        { name: 'SOL', emoji: '🔷', ...prices.SOL }
      ];
      coins.sort((a, b) => b.change - a.change);

      const trendLines = coins.map((coin) => {
        const arrow = coin.change >= 0 ? '🔼' : '🔽';
        const percent = Math.abs(coin.change).toFixed(2);
        return `${coin.emoji} ${coin.name}: $${coin.price.toFixed(2)} ${arrow} ${percent}%`;
      });

      const message =
        `☀️ *Good Morning*\n\n` +
        trendLines.join('\n') + '\n\n' +
        `📊 Market Sentiment: ${sentimentValue} ${emoji}\n` +
        `📅 ${dateStr}` +
        (quote ? `\n\n💬 *Quote of the Day:*\n${quote}` : '');

      for (const jid of groupJids) {
        await sock.sendMessage(jid, { text: message });
      }

      console.log('✅ Sent full morning message!');
    } catch (e) {
      console.error('❌ Error (Morning):', e.message);
    }
  });

  // 🌆 Evening Alert – 6:30 PM IST (13:00 UTC)
   cron.schedule('*/2 * * * *', async () => {
    try {
      const prices = await fetchPrices();
      const fng = await fetchFearGreedIndex();

      const sentimentValue = fng ? `${fng.value}%` : 'N/A';
      const sentimentLabel = fng?.sentiment || 'Neutral';
      const emoji = sentimentLabel.includes('Greed') ? '🟢' : sentimentLabel.includes('Fear') ? '🔴' : '⚪️';

      const coins = [
        { name: 'BTC', emoji: '💹', ...prices.BTC },
        { name: 'ETH', emoji: '💣', ...prices.ETH },
        { name: 'SOL', emoji: '🔷', ...prices.SOL }
      ];
      coins.sort((a, b) => b.change - a.change);

      const trendLines = coins.map((coin) => {
        const arrow = coin.change >= 0 ? '🔼' : '🔽';
        const percent = Math.abs(coin.change).toFixed(2);
        return `${coin.emoji} ${coin.name}: $${coin.price.toFixed(2)} ${arrow} ${percent}%`;
      });

      const message =
        `🌆 *Good Evening*\n\n` +
        trendLines.join('\n') + '\n\n' +
        `📊 Market Sentiment: ${sentimentValue} ${emoji}\n\n` +
        `🔧 _Powered by TeamADS_`;

      for (const jid of groupJids) {
        await sock.sendMessage(jid, { text: message });
      }

      console.log('✅ Sent evening message!');
    } catch (e) {
      console.error('❌ Error (Evening):', e.message);
    }
  });
};

startBot();

const app = express();
app.get('/', (req, res) => res.send('GmBot is running!'));
app.listen(process.env.PORT || 3000, () => {
  console.log('🌐 Express server active to prevent Railway timeout');
});
