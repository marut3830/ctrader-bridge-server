// hybrid-endpoints.js - Sistema ibrido per ricevere dati dal cBot

// Storage in memoria per posizioni del cBot
const cbotPositions = new Map(); // accountId -> posizioni
const cbotTrades = new Map();    // accountId -> trade storici
const lastCbotUpdate = new Map(); // accountId -> timestamp

// Esporta le funzioni per l'uso nel server principale
module.exports = function(app) {

  // Endpoint per ricevere posizioni dal cBot
  app.post('/cbot/positions', async (req, res) => {
    try {
      const { accountId, symbol, positions, authToken } = req.body;
      
      // Verifica token di sicurezza
      if (authToken !== 'CitadelAI_Bridge_Token_2025') {
        return res.status(401).json({ error: 'Invalid auth token' });
      }
      
      if (!accountId || !symbol || !Array.isArray(positions)) {
        return res.status(400).json({ error: 'Missing required fields: accountId, symbol, positions' });
      }
      
      // Salva posizioni in memoria
      const key = `${accountId}_${symbol}`;
      cbotPositions.set(key, {
        accountId,
        symbol,
        positions,
        timestamp: new Date().toISOString(),
        count: positions.length
      });
      
      lastCbotUpdate.set(accountId, Date.now());
      
      console.log(`Received ${positions.length} positions from cBot for ${symbol} on account ${accountId}`);
      
      res.json({
        success: true,
        message: 'Positions updated successfully',
        count: positions.length,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Error handling cBot positions:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint per ricevere trade completati dal cBot
  app.post('/cbot/trades', async (req, res) => {
    try {
      const { accountId, symbol, trade, authToken } = req.body;
      
      if (authToken !== 'CitadelAI_Bridge_Token_2025') {
        return res.status(401).json({ error: 'Invalid auth token' });
      }
      
      if (!accountId || !symbol || !trade) {
        return res.status(400).json({ error: 'Missing required fields: accountId, symbol, trade' });
      }
      
      // Salva trade in memoria
      const key = `${accountId}_${symbol}`;
      if (!cbotTrades.has(key)) {
        cbotTrades.set(key, []);
      }
      
      const trades = cbotTrades.get(key);
      trades.push({
        ...trade,
        receivedAt: new Date().toISOString()
      });
      
      // Mantieni solo ultimi 100 trade per simbolo
      if (trades.length > 100) {
        trades.shift();
      }
      
      lastCbotUpdate.set(accountId, Date.now());
      
      console.log(`Received completed trade from cBot: ${trade.type} ${trade.symbol} profit: ${trade.profit}`);
      
      res.json({
        success: true,
        message: 'Trade recorded successfully',
        tradeId: trade.positionId,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      console.error('Error handling cBot trade:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // Override dell'endpoint posizioni per usare dati del cBot
  app.get('/accounts/:accountId/positions', async (req, res) => {
    try {
      const { accountId } = req.params;
      const { label, symbol } = req.query;
      
      // Cerca posizioni dal cBot per questo account
      const accountPositions = [];
      const currentTime = Date.now();
      
      // Controlla se abbiamo dati recenti (ultimi 5 minuti)
      const lastUpdate = lastCbotUpdate.get(accountId);
      const isDataFresh = lastUpdate && (currentTime - lastUpdate) < 300000; // 5 minuti
      
      for (const [key, data] of cbotPositions.entries()) {
        if (data.accountId === accountId) {
          // Filtra per simbolo se richiesto
          if (symbol && data.symbol !== symbol) continue;
          
          // Filtra per label se richiesto
          let positions = data.positions;
          if (label) {
            positions = positions.filter(pos => 
              pos.label && pos.label.includes(label)
            );
          }
          
          accountPositions.push({
            symbol: data.symbol,
            positions: positions,
            lastUpdate: data.timestamp,
            count: positions.length
          });
        }
      }
      
      res.json({
        accountId: accountId,
        labelFilter: label || null,
        symbolFilter: symbol || null,
        positions: accountPositions,
        totalCount: accountPositions.reduce((sum, item) => sum + item.count, 0),
        dataFreshness: isDataFresh ? 'fresh' : 'stale',
        lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : null,
        timestamp: new Date().toISOString(),
        source: 'cBot-hybrid'
      });
      
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Override dell'endpoint trade history
  app.get('/accounts/:accountId/trades', async (req, res) => {
    try {
      const { accountId } = req.params;
      const { symbol, limit = 50 } = req.query;
      
      const accountTrades = [];
      
      for (const [key, trades] of cbotTrades.entries()) {
        const [keyAccountId, keySymbol] = key.split('_');
        
        if (keyAccountId === accountId) {
          if (symbol && keySymbol !== symbol) continue;
          
          accountTrades.push({
            symbol: keySymbol,
            trades: trades.slice(-limit) // Ultimi N trade
          });
        }
      }
      
      const totalTrades = accountTrades.reduce((sum, item) => sum + item.trades.length, 0);
      
      res.json({
        accountId: accountId,
        symbolFilter: symbol || null,
        trades: accountTrades,
        totalCount: totalTrades,
        limit: parseInt(limit),
        timestamp: new Date().toISOString(),
        source: 'cBot-hybrid'
      });
      
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // Endpoint per stato sistema ibrido
  app.get('/cbot/status', (req, res) => {
    const stats = {
      totalAccounts: new Set([...cbotPositions.keys(), ...cbotTrades.keys()].map(k => k.split('_')[0])).size,
      totalSymbols: new Set([...cbotPositions.keys(), ...cbotTrades.keys()].map(k => k.split('_')[1])).size,
      positionSources: cbotPositions.size,
      tradeSources: cbotTrades.size,
      lastUpdates: Object.fromEntries(lastCbotUpdate),
      systemType: 'hybrid-rest-push'
    };
    
    res.json({
      message: 'cBot hybrid system active',
      stats: stats,
      timestamp: new Date().toISOString()
    });
  });

  // Funzione per ottenere statistiche (per status principale)
  function getHybridStats() {
    return {
      active: true,
      cbotPositions: cbotPositions.size,
      cbotTrades: cbotTrades.size,
      lastCbotUpdates: Object.keys(Object.fromEntries(lastCbotUpdate)).length
    };
  }

  return { getHybridStats };
};
