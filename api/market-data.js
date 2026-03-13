/**
 * RevOptima — Vercel Serverless Function
 * /api/market-data.js
 * 
 * Esta función es la versión serverless del bridge Express.
 * En producción (Vercel) no podemos usar un proceso Express persistente,
 * por lo que la lógica se ejecuta como función bajo demanda.
 * 
 * El MCP de Airbnb se invoca como child_process stdio igual que en local.
 */

const { spawn } = require('child_process');

// ─── Zone Config ──────────────────────────────────────────────────────────────
const ZONE_QUERIES = {
  'Playa de las Américas': 'Playa de las Americas, Tenerife, Spain',
  'Los Gigantes':          'Los Gigantes, Tenerife, Spain',
  'El Médano':             'El Medano, Tenerife, Spain',
  'Abades':                'Abades, Tenerife, Spain',
};

// ─── MCP Client ───────────────────────────────────────────────────────────────
function callMcpTool(toolName, toolArgs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { mcpProcess.kill(); } catch {}
      reject(new Error(`MCP timeout for: ${toolName}`));
    }, 28000); // 28s (Vercel serverless max ~30s)

    const mcpProcess = spawn('npx', ['-y', '@openbnb/mcp-server-airbnb', '--ignore-robots-txt'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let outputBuffer = '';
    let requestSent = false;

    const initRequest = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'revoptima', version: '1.0.0' } }
    }) + '\n';

    const toolRequest = JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: toolName, arguments: toolArgs }
    }) + '\n';

    mcpProcess.stdout.on('data', (data) => {
      outputBuffer += data.toString();
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop();

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed.id === 1 && !requestSent) {
            mcpProcess.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
            mcpProcess.stdin.write(toolRequest);
            requestSent = true;
          }
          if (parsed.id === 2) {
            clearTimeout(timeout);
            try { mcpProcess.kill(); } catch {}
            parsed.error ? reject(new Error(parsed.error.message)) : resolve(parsed.result);
          }
        } catch {}
      }
    });

    mcpProcess.on('error', (err) => { clearTimeout(timeout); reject(err); });
    mcpProcess.stdin.write(initRequest);
  });
}

// ─── Price Parser ─────────────────────────────────────────────────────────────
function parseNightlyPrice(priceDetails) {
  if (!priceDetails) return 0;
  
  // Ignoramos si es un total de varios días para evitar inflar el ADR
  const isTotal = priceDetails.toLowerCase().includes('total');
  
  const match = priceDetails.match(/([€$£]\s*[\d,.]+)|([\d,.]+\s*[€$£])/);
  if (!match) return 0;
  
  let cleanPrice = match[0].replace(/[€$£\s]/g, '').replace(',', '.');
  
  // Manejar miles (ej: 1.200 -> 1200)
  if ((cleanPrice.match(/\./g) || []).length > 1 || (cleanPrice.includes('.') && cleanPrice.length - cleanPrice.indexOf('.') > 3)) {
    cleanPrice = cleanPrice.replace('.', '');
  }
  
  let price = parseFloat(cleanPrice);
  
  // Si detectamos que es un total, intentamos dividirlo por 7 (estancia por defecto) 
  // pero lo más seguro es ignorarlo si no estamos seguros
  if (isTotal) return 0; 

  // Filtro de "basura": Precios menores a 25€ suelen ser errores o depósitos
  // Tenerife no tiene apartamentos enteros a 11€/noche.
  return (price >= 25) ? price : 0;
}

function parseBedroomsFromLine(primaryLine) {
  if (!primaryLine) return 1;
  const match = primaryLine.match(/(\d+)\s+bedroom/i);
  return match ? Math.min(parseInt(match[1]), 3) : 1;
}

function parseUnitType(primaryLine, secondaryLine) {
  const text = (primaryLine + " " + (secondaryLine || "")).toLowerCase();
  if (text.includes('shared room') || text.includes('habitación compartida') || text.includes('cama')) return 'Cama';
  if (text.includes('private room') || text.includes('habitación privada')) return 'Habitación';
  if (text.includes('villa') || text.includes('house') || text.includes('casa') || text.includes('chalet')) return 'Villa';
  return 'Apartamento';
}

// ─── Adapter ──────────────────────────────────────────────────────────────────
function adaptToMarketData(mcpResult, zoneName, weekLabel, monthLabel) {
  let listings = [];
  try {
    const text = mcpResult?.content?.[0]?.text;
    if (text) listings = JSON.parse(text).searchResults || [];
  } catch { return []; }

  if (!listings.length) return [];

  const byTypeBeds = { 
    'Apartamento': { 1: [], 2: [], 3: [] },
    'Habitación': { 1: [], 2: [], 3: [] },
    'Villa': { 1: [], 2: [], 3: [] },
    'Cama': { 1: [], 2: [], 3: [] }
  };

  listings.forEach(l => {
    const price = parseNightlyPrice(l?.structuredDisplayPrice?.explanationData?.priceDetails);
    const primary = l?.structuredContent?.primaryLine || "";
    const secondary = l?.structuredContent?.secondaryLine || "";
    const beds = parseBedroomsFromLine(primary);
    const type = parseUnitType(primary, secondary);
    
    // Filtro adicional: Si el precio es absurdamente alto (>3000€/noche) lo ignoramos salvo si es Villa
    if (price > 0) {
      if (type !== 'Villa' && price > 1500) return;
      if (price > 8000) return; // Límite absoluto de seguridad
      byTypeBeds[type][Math.min(beds, 3)].push(price);
    }
  });

  const results = [];
  const getPercentile = (arr, p) => {
    if (arr.length === 0) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const pos = (s.length - 1) * p;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (s[base + 1] !== undefined) {
      return s[base] + rest * (s[base + 1] - s[base]);
    } else {
      return s[base];
    }
  };

  ['Apartamento', 'Habitación', 'Villa', 'Cama'].forEach(type => {
    for (let beds = 1; beds <= 3; beds++) {
      let prices = byTypeBeds[type][beds];
      if (!prices.length) {
        // ... lógica de fallback ...
        continue; // Mejor no inventar si no hay datos
      }
      
      // Limpiamos outliers internos (IQ Range)
      const p25 = getPercentile(prices, 0.25);
      const p75 = getPercentile(prices, 0.75);
      const iqr = p75 - p25;
      const cleanPrices = prices.filter(p => p >= (p25 - 1.5 * iqr) && p <= (p75 + 1.5 * iqr));
      const finalPrices = cleanPrices.length > 0 ? cleanPrices : prices;

      results.push({
        location: zoneName,
        type,
        beds,
        week: weekLabel,
        month: monthLabel,
        minPrice: Math.round(getPercentile(finalPrices, 0.1)), // P10 como suelo real
        maxPrice: Math.round(getPercentile(finalPrices, 0.7)), // P70 como techo real (más representativo)
        avgPrice: Math.round(finalPrices.reduce((a, b) => a + b, 0) / finalPrices.length),
        medianPrice: Math.round(getPercentile(finalPrices, 0.5)),
        availableCount: finalPrices.length
      });
    }
  });
  return results;
}

// ─── Utilities ────────────────────────────────────────────────────────────────
function getMonthFromWeek(week) {
  const months = [
    'Enero','Enero','Enero','Enero','Enero',
    'Febrero','Febrero','Febrero','Febrero',
    'Marzo','Marzo','Marzo','Marzo','Marzo',
    'Abril','Abril','Abril','Abril',
    'Mayo','Mayo','Mayo','Mayo',
    'Junio','Junio','Junio','Junio','Junio',
    'Julio','Julio','Julio','Julio',
    'Agosto','Agosto','Agosto','Agosto','Agosto',
    'Septiembre','Septiembre','Septiembre','Septiembre',
    'Octubre','Octubre','Octubre','Octubre','Octubre',
    'Noviembre','Noviembre','Noviembre','Noviembre',
    'Diciembre','Diciembre','Diciembre','Diciembre','Diciembre'
  ];
  return months[week - 1] || 'Diciembre';
}

function getDateRangeForWeek(weekNumber) {
  const currentYear = new Date().getFullYear();
  const today = new Date();
  
  const getDates = (y) => {
    const jan4 = new Date(y, 0, 4);
    const dow = jan4.getDay() || 7;
    const start = new Date(jan4);
    start.setDate(jan4.getDate() - dow + 1 + (weekNumber - 1) * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return { start, end };
  };

  let dates = getDates(currentYear);
  
  // Si el fin de semana ya pasó, saltamos al año que viene
  if (dates.end < today) {
    dates = getDates(currentYear + 1);
  }

  return {
    checkin: dates.start.toISOString().split('T')[0],
    checkout: dates.end.toISOString().split('T')[0]
  };
}

// ─── Serverless Handler ───────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { location, weeks } = req.query;
  const zonesToQuery = location && ZONE_QUERIES[location]
    ? { [location]: ZONE_QUERIES[location] }
    : ZONE_QUERIES;

  const currentWeek = Math.ceil((Date.now() - new Date(new Date().getFullYear(), 0, 1)) / (7 * 86400000));
  const weekNumbers = weeks
    ? weeks.split(',').map(Number).filter(w => w >= 1 && w <= 52)
    : Array.from({ length: 4 }, (_, i) => Math.min(currentWeek + i, 52));

  const allResults = [];
  const errors = [];

  for (const [zoneName, zoneQuery] of Object.entries(zonesToQuery)) {
    for (const weekNum of weekNumbers) {
      try {
        const { checkin, checkout } = getDateRangeForWeek(weekNum);
        const mcpResult = await callMcpTool('airbnb_search', {
          location: zoneQuery, checkin, checkout, adults: 2, ignoreRobotsText: true
        });
        allResults.push(...adaptToMarketData(mcpResult, zoneName, `Semana ${weekNum}`, getMonthFromWeek(weekNum)));
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        errors.push({ zone: zoneName, week: weekNum, error: err.message });
      }
    }
  }

  res.json({ success: true, count: allResults.length, errors: errors.length ? errors : undefined, data: allResults });
};
