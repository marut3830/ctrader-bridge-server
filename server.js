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

// Variabili per connessione TCP
let wsConnection = null;
let isConnected = false;
let authAccounts = new Map(); // accountId -> isAuthenticated
let protobufRoot = null;

// Carica definizioni Protobuf
async function loadProtobuf() {
  try {
    // Per ora usa definizioni inline semplici
    protobufRoot = {
      // Simulazione delle definizioni protobuf necessarie
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

// Connessione WebSocket a cTrader
async function connectToCTrader() {
  try {
    console.log('Connecting to cTrader Open API...');
    
    // Endpoint WebSocket cTrader (demo)
    const wsUrl = 'wss://openapi.ctrader.com:5036';
    wsConnection = new WebSocket(wsUrl);
    
    wsConnection.on('open', () => {
      console.log('Connected to cTrader Open API via WebSocket');
      isConnected = true;
      authenticateApplication();
    });
    
    wsConnection.on('message', (data) => {
      handleCTraderMessage(data);
    });
    
    wsConnection.on('error', (error) => {
      console.error('WebSocket error:', error);
      isConnected = false;
    });
    
    wsConnection.on('close', () => {
      console.log('WebSocket connection closed');
      isConnected = false;
      // Riconnetti dopo 5 secondi
      setTimeout(() => {
        if (!isConnected) {
          connectToCTrader();
        }
      }, 5000);
    });
    
  } catch (error) {
    console.error('Error connecting to cTrader:', error);
  }
}

// Autenticazione applicazione
function authenticateApplication() {
  if (!wsConnection || !isConnected) return;
  
  try {
    const authMessage = {
      payloadType: 2100, // ProtoOAApplicationAuthReq
      payload: {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET
      }
    };
    
    wsConnection.send(JSON.stringify(authMessage));
    console.log('Application authentication request sent');
  } catch (error) {
    console.error('Error authenticating application:', error);
  }
}

// Autentica account specifico
async function authenticateAccount(accountId) {
  if (!wsConnection || !isConnected) {
    throw new Error('Not connected to cTrader');
  }
  
  try {
    const token = await getValidToken();
    
    // Prima ottieni la lista account
    const accountListMessage = {
      payloadType: 2149, // ProtoOAGetAccountListByAccessTokenReq
      payload: {
        accessToken: token
      }
    };
    
    wsConnection.send(JSON.stringify(accountListMessage));
    
    // Poi autentica l'account specifico
    setTimeout(() => {
      const accountAuthMessage = {
        payloadType: 2102, // ProtoOAAccountAuthReq
        payload: {
          ctidTraderAccountId: parseInt(accountId),
          accessToken: token
        }
      };
      
      wsConnection.send(JSON.stringify(accountAuthMessage));
      console.log(`Account ${accountId} authentication request sent`);
    }, 1000);
    
  } catch (error) {
    console.error('Error authenticating account:', error);
    throw error;
  }
}

// Gestisce messaggi da cTrader
function handleCTraderMessage(data) {
  try {
    const message = JSON.parse(data.toString());
    
    switch (message.payloadType) {
      case 2101: // ProtoOAApplicationAuthRes
        console.log('Application authenticated successfully');
        break;
        
      case 2103: // ProtoOAAccountAuthRes
        const accountId = message.payload?.ctidTraderAccountId;
        if (accountId) {
          authAccounts.set(accountId.toString(), true);
          console.log(`Account ${accountId} authenticated successfully`);
        }
        break;
        
      case 2150: // ProtoOAGetAccountListByAccessTokenRes
        console.log('Received account list:', message.payload);
        break;
        
      default:
        console.log('Received message type:', message.payloadType);
    }
  } catch (error) {
    console.error('Error handling cTrader message:', error);
  }
}

// Richiedi posizioni per account
async function requestPositions(accountId, labelFilter = null) {
  if (!wsConnection || !isConnected) {
    throw new Error('Not connected to cTrader');
  }
  
  if (!authAccounts.get(accountId)) {
    await authenticateAccount(accountId);
    // Aspetta autenticazione
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timeout waiting for positions response'));
    }, 10000);
    
    const positionsMessage = {
      payloadType: 2118, // ProtoOAGetPositionsReq
      payload: {
        ctidTraderAccountId: parseInt(accountId)
      }
    };
    
    // Listener temporaneo per la risposta
    const messageHandler = (data) => {
      try {
        const message = JSON.parse(data.toString());
        if (message.payloadType === 2119) { // ProtoOAGetPositionsRes
          clearTimeout(timeout);
          wsConnection.removeListener('message', messageHandler);
          
          let positions = message.payload?.position || [];
          
          // Filtra per label se specificato
          if (labelFilter) {
            positions = positions.filter(pos => 
              pos.label && pos.label.includes(labelFilter)
            );
          }
          
          resolve(positions);
        }
      } catch (error) {
        clearTimeout(timeout);
        wsConnection.removeListener('message', messageHandler);
        reject(error);
      }
    };
    
    wsConnection.on('message', messageHandler);
    wsConnection.send(JSON.stringify(positionsMessage));
  });
}

// Funzioni token OAuth (esistenti)
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

// Endpoint REST esistenti
app.get('/', (req, res) => {
  res.json({
    message: 'cTrader Bridge Server is running',
    version: '2.0.0',
    tcpConnection: isConnected ? 'Connected' : 'Disconnected',
    endpoints: [
      'GET /accounts - Get trading accounts list',
      'GET /accounts/:accountId/balance - Get account balance', 
      'GET /accounts/:accountId/positions - Get open positions (TCP)',
      'GET /accounts/:accountId/trades - Get trade history (TCP)',
      'GET /profile - Get user profile',
      'GET /status - Server status'
    ]
  });
});

app.get('/status', async (req, res) => {
  try {
    const token = await getValidToken();
    res.json({
      status: 'online',
      tokenValid: !!token,
      tokenExpiresAt: new Date(tokenCache.expiresAt).toISOString(),
      tcpConnection: isConnected,
      authenticatedAccounts: Array.from(authAccounts.keys()),
      server: 'Render',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      tcpConnection: isConnected,
      timestamp: new Date().toISOString()
    });
  }
});

// Funzioni API REST esistenti (callSpotwareAPI, ecc.)
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

// Endpoint REST esistenti
app.get('/profile', async (req, res) => {
  try {
    const data = await callSpotwareAPI('/connect/profile');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/accounts', async (req, res) => {
  try {
    const data = await callSpotwareAPI('/connect/tradingaccounts');
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

// NUOVI endpoint TCP per posizioni e trade
app.get('/accounts/:accountId/positions', async (req, res) => {
  try {
    const { accountId } = req.params;
    const { label } = req.query;
    
    if (!isConnected) {
      return res.status(503).json({
        error: 'TCP connection not available',
        message: 'Bridge server is not connected to cTrader Open API'
      });
    }
    
    const positions = await requestPositions(accountId, label);
    
    res.json({
      accountId: accountId,
      labelFilter: label || null,
      positions: positions,
      count: positions.length,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      tcpConnected: isConnected 
    });
  }
});

app.get('/accounts/:accountId/positions/filtered', async (req, res) => {
  const { accountId } = req.params;
  const { label } = req.query;
  
  res.json({
    message: 'Label filtering ready - now uses real TCP connection',
    accountId: accountId,
    labelFilter: label || 'none',
    tcpStatus: isConnected ? 'Connected' : 'Disconnected',
    example: `Call /accounts/${accountId}/positions?label=AIGridBot_EURUSD to get only cBot positions`
  });
});

app.get('/accounts/:accountId/trades', async (req, res) => {
  res.status(501).json({
    error: 'Trade history endpoint not implemented yet',
    message: 'Coming soon with TCP connection',
    tcpStatus: isConnected ? 'Connected' : 'Disconnected'
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

app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: ['/accounts', '/profile', '/status', '/']
  });
});

// Inizializzazione server
async function startServer() {
  await loadProtobuf();
  
  // Avvia connessione TCP dopo 3 secondi per dare tempo al server REST
  setTimeout(() => {
    connectToCTrader();
  }, 3000);
  
  app.listen(PORT, () => {
    console.log(`cTrader Bridge Server v2.0 running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
    
    if (!CLIENT_ID || !CLIENT_SECRET || !ACCESS_TOKEN) {
      console.warn('WARNING: Missing required environment variables!');
      console.warn('Please set: CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN');
    } else {
      console.log('Configuration loaded successfully');
      console.log('TCP connection will start in 3 seconds...');
    }
  });
}

startServer();
