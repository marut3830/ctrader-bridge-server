const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const WebSocket = require('ws');
const protobuf = require('protobufjs');
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
  expiresAt: Date.now() + (3600 * 1000)
};

// Variabili per connessione TCP (mantenute per compatibilità)
let wsConnection = null;
let isConnected = false;
let authAccounts = new Map();
let protobufRoot = null;

// Carica definizioni Protobuf
async function loadProtobuf() {
  try {
    protobufRoot = {
      ApplicationAuthReq: { create: (data) => data },
      GetAccountListReq: { create: (data) => data },
      AccountAuthReq: { create: (data) => data },
      GetPositionsReq: { create: (data) => data },
      decode: (buffer) => JSON.parse(buffer.toString())
    };
    console.log('Protobuf definitions loaded');
  } catch (error) {
    console.error('Error loading protobuf:', error);
  }
}

// Funzioni token OAuth
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

async function getValidToken() {
  if (Date.now() + (5 * 60 * 1000) >= tokenCache.expiresAt) {
    console.log('Token expiring soon, refreshing...');
    const newToken = await refreshAccessToken();
    if (!newToken) {
      throw new Error('Unable to refresh token');
    }
  }
  return tokenCache.accessToken;
}

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

// Import del sistema ibrido
const hybridEndpoints = require('./hybrid-endpoints');
const hybridStats = hybridEndpoints(app);

// ROOT endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'cTrader Bridge Server is running',
    version: '2.1.0-hybrid',
    tcpConnection: isConnected ? 'Connected' : 'Disconnected',
    hybridSystem: 'Active',
    endpoints: [
      'GET /accounts - Get trading accounts list',
      'GET /accounts/:accountId/balance - Get account balance', 
      'GET /accounts/:accountId/positions - Get open positions (hybrid)',
      'GET /accounts/:accountId/trades - Get trade history (hybrid)',
      'POST /cbot/positions - Receive positions from cBot',
      'POST /cbot/trades - Receive trades from cBot',
      'GET /cbot/status - Hybrid system status',
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
      tcpConnection: isConnected,
      authenticatedAccounts: Array.from(authAccounts.keys()),
      hybridSystem: hybridStats.getHybridStats(),
      server: 'Render',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      tcpConnection: isConnected,
      hybridSystem: hybridStats.getHybridStats(),
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

// Get account balance
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

// Endpoint per testare il filtro label
app.get('/accounts/:accountId/positions/filtered', async (req, res) => {
  const { accountId } = req.params;
  const { label } = req.query;
  
  res.json({
    message: 'Label filtering ready - now uses hybrid cBot system',
    accountId: accountId,
    labelFilter: label || 'none',
    systemType: 'hybrid-push',
    example: `Call /accounts/${accountId}/positions?label=AIGridBot_EURUSD to get only cBot positions`
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
    availableEndpoints: ['/accounts', '/profile', '/status', '/cbot/status', '/']
  });
});

// Inizializzazione server
async function startServer() {
  await loadProtobuf();
  
  app.listen(PORT, () => {
    console.log(`cTrader Bridge Server v2.1-hybrid running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    
    if (!CLIENT_ID || !CLIENT_SECRET || !ACCESS_TOKEN) {
      console.warn('WARNING: Missing required environment variables!');
      console.warn('Please set: CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN');
    } else {
      console.log('Configuration loaded successfully');
      console.log('Hybrid system active - ready to receive cBot data');
    }
  });
}

startServer();
