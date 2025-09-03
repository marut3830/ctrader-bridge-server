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

// ✅ NUOVO: Storage per dati cBot
let cbotData = {
  positions: [],
  trades: [],
  stressEvents: []
};

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
      'POST /cbot/stress - Receive stress events from cBot',
      'GET /cbot/positions - Get stored cBot positions',
      'GET /cbot/trades - Get stored cBot trades',
      'GET /cbot/stress - Get stored cBot stress events',
      'GET /cbot/status - Hybrid system status',
      'GET /profile - Get user profile',
      'GET /status - Server status'
    ]
  });
});

// ✅ NUOVI ENDPOINT cBot - POST (per ricevere dati dal cBot)
app.post('/cbot/positions', (req, res) => {
  try {
    const positionData = req.body;
    console.log('Received position data from cBot:', positionData.symbol, positionData.tradeType, positionData.netProfit);
    
    // Trova e aggiorna posizione esistente o aggiungi nuova
    const existingIndex = cbotData.positions.findIndex(p => 
      p.positionId === positionData.positionId && p.symbol === positionData.symbol
    );
    
    if (existingIndex !== -1) {
      cbotData.positions[existingIndex] = { ...positionData, lastUpdate: new Date().toISOString() };
    } else {
      cbotData.positions.push({ ...positionData, lastUpdate: new Date().toISOString() });
    }
    
    // Mantieni solo le ultime 1000 posizioni
    if (cbotData.positions.length > 1000) {
      cbotData.positions = cbotData.positions.slice(-1000);
    }
    
    res.json({ 
      success: true, 
      message: 'Position data received and stored',
      totalPositions: cbotData.positions.length
    });
  } catch (error) {
    console.error('Error processing position data:', error);
    res.status(500).json({ error: 'Failed to process position data' });
  }
});

app.post('/cbot/trades', (req, res) => {
  try {
    const tradeData = req.body;
    console.log('Received trade data from cBot:', tradeData.symbol, tradeData.tradeType, tradeData.netProfit);
    
    // Aggiungi trade (non aggiornare, sempre nuovi)
    cbotData.trades.push({ ...tradeData, lastUpdate: new Date().toISOString() });
    
    // Mantieni solo gli ultimi 5000 trade
    if (cbotData.trades.length > 5000) {
      cbotData.trades = cbotData.trades.slice(-5000);
    }
    
    res.json({ 
      success: true, 
      message: 'Trade data received and stored',
      totalTrades: cbotData.trades.length
    });
  } catch (error) {
    console.error('Error processing trade data:', error);
    res.status(500).json({ error: 'Failed to process trade data' });
  }
});

app.post('/cbot/stress', (req, res) => {
  try {
    const stressData = req.body;
    console.log('Received stress event from cBot:', stressData.symbol, stressData.maxDrawdown);
    
    // Aggiungi evento stress
    cbotData.stressEvents.push({ ...stressData, lastUpdate: new Date().toISOString() });
    
    // Mantieni solo gli ultimi 500 eventi stress
    if (cbotData.stressEvents.length > 500) {
      cbotData.stressEvents = cbotData.stressEvents.slice(-500);
    }
    
    res.json({ 
      success: true, 
      message: 'Stress event received and stored',
      totalStressEvents: cbotData.stressEvents.length
    });
  } catch (error) {
    console.error('Error processing stress data:', error);
    res.status(500).json({ error: 'Failed to process stress data' });
  }
});

// ✅ NUOVI ENDPOINT cBot - GET (per fornire dati al Google Apps Script)
app.get('/cbot/positions', (req, res) => {
  try {
    const { symbol, label, limit = 100 } = req.query;
    let filteredPositions = cbotData.positions;
    
    // Applica filtri
    if (symbol) {
      filteredPositions = filteredPositions.filter(p => 
        p.symbol && p.symbol.toLowerCase().includes(symbol.toLowerCase())
      );
    }
    
    if (label) {
      filteredPositions = filteredPositions.filter(p => 
        p.label && p.label.includes(label)
      );
    }
    
    // Applica limit e ordina per timestamp
    filteredPositions = filteredPositions
      .sort((a, b) => new Date(b.lastUpdate || b.timestamp) - new Date(a.lastUpdate || a.timestamp))
      .slice(0, parseInt(limit));
    
    res.json({
      success: true,
      data: filteredPositions,
      count: filteredPositions.length,
      totalStored: cbotData.positions.length,
      filters: { symbol, label, limit }
    });
  } catch (error) {
    console.error('Error retrieving positions:', error);
    res.status(500).json({ error: 'Failed to retrieve positions' });
  }
});

app.get('/cbot/trades', (req, res) => {
  try {
    const { symbol, label, limit = 1000 } = req.query;
    let filteredTrades = cbotData.trades;
    
    // Applica filtri
    if (symbol) {
      filteredTrades = filteredTrades.filter(t => 
        t.symbol && t.symbol.toLowerCase().includes(symbol.toLowerCase())
      );
    }
    
    if (label) {
      filteredTrades = filteredTrades.filter(t => 
        t.label && t.label.includes(label)
      );
    }
    
    // Applica limit e ordina per exit time
    filteredTrades = filteredTrades
      .sort((a, b) => new Date(b.exitTime || b.lastUpdate) - new Date(a.exitTime || a.lastUpdate))
      .slice(0, parseInt(limit));
    
    res.json({
      success: true,
      data: filteredTrades,
      count: filteredTrades.length,
      totalStored: cbotData.trades.length,
      filters: { symbol, label, limit }
    });
  } catch (error) {
    console.error('Error retrieving trades:', error);
    res.status(500).json({ error: 'Failed to retrieve trades' });
  }
});

app.get('/cbot/stress', (req, res) => {
  try {
    const { symbol, label, limit = 100 } = req.query;
    let filteredStress = cbotData.stressEvents;
    
    // Applica filtri
    if (symbol) {
      filteredStress = filteredStress.filter(s => 
        s.symbol && s.symbol.toLowerCase().includes(symbol.toLowerCase())
      );
    }
    
    if (label) {
      filteredStress = filteredStress.filter(s => 
        s.label && s.label.includes(label)
      );
    }
    
    // Applica limit e ordina per start time
    filteredStress = filteredStress
      .sort((a, b) => new Date(b.startTime || b.lastUpdate) - new Date(a.startTime || a.lastUpdate))
      .slice(0, parseInt(limit));
    
    res.json({
      success: true,
      data: filteredStress,
      count: filteredStress.length,
      totalStored: cbotData.stressEvents.length,
      filters: { symbol, label, limit }
    });
  } catch (error) {
    console.error('Error retrieving stress events:', error);
    res.status(500).json({ error: 'Failed to retrieve stress events' });
  }
});

// Status endpoint (modificato per includere stats cBot)
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
      cbotDataStats: {
        positions: cbotData.positions.length,
        trades: cbotData.trades.length,
        stressEvents: cbotData.stressEvents.length,
        lastPositionUpdate: cbotData.positions.length > 0 ? 
          cbotData.positions[cbotData.positions.length - 1].lastUpdate : null
      },
      server: 'Render',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      tcpConnection: isConnected,
      hybridSystem: hybridStats.getHybridStats(),
      cbotDataStats: {
        positions: cbotData.positions.length,
        trades: cbotData.trades.length,
        stressEvents: cbotData.stressEvents.length
      },
      timestamp: new Date().toISOString()
    });
  }
});

// cBot status endpoint specifico
app.get('/cbot/status', (req, res) => {
  const now = new Date();
  const recentPositions = cbotData.positions.filter(p => 
    new Date(p.lastUpdate || p.timestamp) > new Date(now - 24 * 60 * 60 * 1000)
  ).length;
  
  const recentTrades = cbotData.trades.filter(t => 
    new Date(t.lastUpdate || t.exitTime) > new Date(now - 24 * 60 * 60 * 1000)
  ).length;

  res.json({
    status: 'active',
    dataReceived: {
      totalPositions: cbotData.positions.length,
      totalTrades: cbotData.trades.length,
      totalStressEvents: cbotData.stressEvents.length,
      recentPositions24h: recentPositions,
      recentTrades24h: recentTrades
    },
    lastActivity: cbotData.positions.length > 0 ? 
      Math.max(
        ...cbotData.positions.map(p => new Date(p.lastUpdate || p.timestamp).getTime()),
        ...cbotData.trades.map(t => new Date(t.lastUpdate || t.exitTime).getTime())
      ) : null,
    endpoints: {
      'POST /cbot/positions': 'Receive position data from cBot',
      'POST /cbot/trades': 'Receive trade data from cBot', 
      'POST /cbot/stress': 'Receive stress events from cBot',
      'GET /cbot/positions': 'Retrieve stored positions',
      'GET /cbot/trades': 'Retrieve stored trades',
      'GET /cbot/stress': 'Retrieve stored stress events'
    },
    timestamp: new Date().toISOString()
  });
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

// 404 handler (aggiornato con i nuovi endpoint)
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: [
      '/accounts', 
      '/profile', 
      '/status', 
      '/cbot/status', 
      '/cbot/positions', 
      '/cbot/trades', 
      '/cbot/stress',
      '/'
    ]
  });
});

// Inizializzazione server
async function startServer() {
  await loadProtobuf();
  
  app.listen(PORT, () => {
    console.log(`cTrader Bridge Server v2.1-hybrid running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log('✅ cBot endpoints active: /cbot/positions, /cbot/trades, /cbot/stress');
    
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
