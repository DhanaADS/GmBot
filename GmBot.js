const fs = require('fs');
const unzipper = require('unzipper');
const axios = require('axios');
const qrcode = require('qrcode-terminal');
const cron = require('node-cron');
const express = require('express');
const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
require('dotenv').config();

// 🔓 Unzip auth_info from Railway ENV
if (process.env.AUTH_ZIP && !fs.existsSync('./auth_info')) {
  try {
    const buffer = Buffer.from(process.env.AUTH_ZIP, 'base64');
    fs.writeFileSync('auth_info.zip', buffer);
    fs.createReadStream('auth_info.zip')
      .pipe(unzipper.Extract({ path: '.' }))
      .on('error', (err) => {
        console.error('❌ Error unzipping auth_info:', err.message);
      })
      .on('finish', () => {
        console.log('✅ auth_info unzipped successfully');
        if (!fs.existsSync('./auth_info')) {
          console.error('❌ auth_info directory not found after unzipping');
        }
      });
  } catch (err) {
    console.error('❌ Error processing AUTH_ZIP:', err.message);
  }
} else if (!process.env.AUTH_ZIP) {
  console.warn('⚠️ AUTH_ZIP environment variable not set');
} else {
  console.log('✅ auth_info directory already exists');
}

const groupJids = ['120363399532849287@g.us'];

// Cache for API responses
let priceCache = null;
let fngCache = null;
let lastCacheTime = 0;
const cacheDuration = 5 * 60 * 1000; // 5 minutes

const fetchPrices = async () => {
  if (priceCache && Date.now() - lastCacheTime < cacheDuration) {
    console.log('📈 Using cached prices');
    return priceCache;
  }
  try {
    const res = await axios.get('https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest', {
      headers: { 'X-CMC_PRO_API_KEY': process.env.CMC_API_KEY },
      params: { symbol: 'BTC,ETH,SOL', convert: 'USD' }
    });
    priceCache = {
      BTC: { price: res.data.data.BTC.quote.USD.price, change: res.data.data.BTC.quote.USD.percent_change_24h },
      ETH: { price: res.data.data.ETH.quote.USD.price, change: res.data.data.ETH.quote.USD.percent_change_24h },
      SOL: { price: res.data.data.SOL.quote.USD.price, change: res.data.data.SOL.quote.USD.percent_change_24h }
    };
    lastCacheTime = Date.now();
    console.log('📈 Fetched new prices');
    return priceCache;
  } catch (err) {
    console.error('❌ Error fetching prices from CoinMarketCap:', err.message);
    return priceCache || {
      BTC: { price: 0, change: 0 },
      ETH: { price: 0, change: 0 },
      SOL: { price: 0, change: 0 }
    };
  }
};

const fetchFearGreedIndex = async () => {
  if (fngCache && Date.now() - lastCacheTime < cacheDuration) {
    console.log('📊 Using cached Fear & Greed Index');
    return fngCache;
  }
  try {
    const response = await axios.get('https://api.alternative.me/fng/?limit=1');
    fngCache = {
      value: response.data.data[0].value,
      sentiment: response.data.data[0].value_classification
    };
    lastCacheTime = Date.now();
    console.log('📊 Fetched new Fear & Greed Index');
    return fngCache;
  } catch (err) {
    console.error('❌ Error fetching Fear & Greed Index:', err.message);
    return fngCache || null;
  }
};

const startBot = async () => {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info');
  const sock = makeWASocket({ auth: state });

  sock.ev.on('creds.update', saveCreds);

  let reconnectAttempts = 0;
  const maxReconnectAttempts = 5;
  const maxBackoff = 60000;

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('📱 QR code generated');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') {
      console.log('✅ WhatsApp connected!');
      reconnectAttempts = 0;
    } else if (connection === 'close') {
      const reason = lastDisconnect?.error?.message || 'Unknown reason';
      console.error(`❌ Connection closed. Reason: ${reason}`);
      if (reconnectAttempts < maxReconnectAttempts) {
        const backoff = Math.min(1000 * Math.pow(2, reconnectAttempts), maxBackoff);
        console.log(`🔄 Reconnecting in ${backoff / 1000} seconds... (Attempt ${reconnectAttempts + 1}/${maxReconnectAttempts})`);
        reconnectAttempts++;
        setTimeout(() => startBot(), backoff);
      } else {
        console.error('❌ Max reconnection attempts reached. Please check authentication or network.');
      }
    }
  });

  sock.ev.on('stream.error', (error) => {
    console.error('❌ Stream Error:', error);
  });

  sock.ws.on('error', (error) => {
    console.error('❌ WebSocket Error:', error);
  });

  // 💬 Group ID Reader
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

  // ☀️ Morning Alert – 9:15 AM IST (3:45 AM UTC)
  cron.schedule('15 3 * * *', async () => {
    try {
      const prices = await fetchPrices();
      const fng = await fetchFearGreedIndex();

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
        `📅 ${dateStr}`;

      for (const jid of groupJids) {
        await sock.sendMessage(jid, { text: message });
      }

      console.log('✅ Sent full morning message!');
    } catch (e) {
      console.error('❌ Error (Morning):', e.message);
    }
  });

  // 🌆 Evening Alert – 8:15 PM IST (2:45 PM UTC)
  cron.schedule('15 14 * * *', async () => {
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

  // --- Express server ---
  const app = express();
  app.get('/', (req, res) => res.send('GmBot is running!'));
  app.get('/health', (req, res) => {
    const status = sock.ws.readyState === 1 ? 'connected' : 'disconnected';
    res.json({ status, uptime: process.uptime(), lastCacheTime: new Date(lastCacheTime).toISOString() });
  });
  app.listen(process.env.PORT || 3000, () => {
    console.log('🌐 Express server active to prevent Railway timeout');
  });
};

startBot();