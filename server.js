const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Variabili ambiente per cTrader
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;

// Cache per token
let tokenCache = {
  accessToken: ACCESS_TOKEN,
  refreshToken: REFRESH_TOKEN,
  expiresAt: Date.now() + (3600 * 1000) // 1 ora default
};

// Funzione per refresh token
async function refreshAccessToken() {
  try {
    const url = `https://openapi.ctrader.com/apps/token?grant_type=refresh_token&refresh_token=${tokenCache.refreshToken}&client_id=${CLIENT_ID}&client_secret=${CLIENT_SECRET}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    const data = await response.json();
    
    if (data.accessToken) {
      tokenCache.accessToken = data.accessToken;
      if (data.refreshToken) tokenCache.refreshToken = data.refreshToken;
      tokenCache.expiresAt = Date.now() + (data.expiresIn * 1000);
      console.log('Token refreshed successfully');
      return tokenCache.accessToken;
    } else {
      console.error('Token refresh failed:', data);
      return null;
    }
  } catch (error) {
    console.error('Token refresh error:', error);
    return null;
  }
}

// Funzione per ottenere token valido
async function getValidToken() {
  // Se token scade tra meno di 5 minuti, rinnova
  if (Date.now() + (5 * 60 * 1000) >= tokenCache.expiresAt) {
    console.log('Token expiring soon, refreshing...');
    const newToken = await refreshAccessToken();
    if (!newToken) {
      throw new Error('Unable to refresh token');
    }
  }
  return tokenCache.accessToken;
}

// Funzione per chiamare API Spotware
async function callSpotwareAPI(endpoint) {
  try {
    const token = await getValidToken();
    const url = `https://api.spotware.com${endpoint}${endpoint.includes('?') ? '&' : '?'}oauth_token=${encodeURIComponent(token)}`;
    
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    });
    
    if (!response.ok) {
      throw new Error(`API call failed: ${response.status} ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('API call error:', error);
    throw error;
  }
}

// ROOT endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'cTrader Bridge Server is running',
    version: '1.0.0',
    endpoints: [
      'GET /accounts - Get trading accounts list',
      'GET /accounts/:accountId/balance - Get account balance', 
      'GET /accounts/:accountId/positions - Get open positions',
      'GET /accounts/:accountId/trades - Get trade history',
      'GET /profile - Get user profile',
      'GET /status - Server status'
    ]
  });
});

// Status endpoint
app.get('/status', async (req, res) => {
  try {
    const token = await getValidToken();
    res.json({
      status: 'online',
      tokenValid: !!token,
      tokenExpiresAt: new Date(tokenCache.expiresAt).toISOString(),
      server: 'Railway',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get user profile
app.get('/profile', async (req, res) => {
  try {
    const data = await callSpotwareAPI('/connect/profile');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get trading accounts
app.get('/accounts', async (req, res) => {
  try {
    const data = await callSpotwareAPI('/connect/tradingaccounts');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get account balance (usando i dati già disponibili dall'endpoint accounts)
app.get('/accounts/:accountId/balance', async (req, res) => {
  try {
    const { accountId } = req.params;
    const data = await callSpotwareAPI('/connect/tradingaccounts');
    
    const account = data.data?.find(acc => acc.accountId.toString() === accountId);
    
    if (!account) {
      return res.status(404).json({ error: 'Account not found' });
    }
    
    res.json({
      accountId: account.accountId,
      accountNumber: account.accountNumber,
      balance: account.balance / Math.pow(10, account.moneyDigits),
      currency: account.depositCurrency,
      leverage: account.leverage,
      accountType: account.live ? 'LIVE' : 'DEMO',
      status: account.accountStatus,
      lastUpdate: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Placeholder endpoints per posizioni e trade (da implementare con WebSocket)
app.get('/accounts/:accountId/positions', async (req, res) => {
  res.status(501).json({
    error: 'Open positions endpoint not implemented yet',
    message: 'This requires WebSocket/TCP connection to cTrader Open API',
    alternative: 'Use /accounts endpoint to get balance information'
  });
});

app.get('/accounts/:accountId/trades', async (req, res) => {
  res.status(501).json({
    error: 'Trade history endpoint not implemented yet',
    message: 'This requires WebSocket/TCP connection to cTrader Open API',
    alternative: 'Use /accounts endpoint to get account information'
  });
});

// Error handling
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    error: 'Internal server error',
    message: error.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: ['/accounts', '/profile', '/status', '/']
  });
});

app.listen(PORT, () => {
  console.log(`cTrader Bridge Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  if (!CLIENT_ID || !CLIENT_SECRET || !ACCESS_TOKEN) {
    console.warn('WARNING: Missing required environment variables!');
    console.warn('Please set: CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN');
  } else {
    console.log('Configuration loaded successfully');
  }
});
