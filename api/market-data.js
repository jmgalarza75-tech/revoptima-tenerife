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
  const match = priceDetails.match(/x\s*[€$£]\s*[\d,]+\.?\d*/);
  if (!match) return 0;
  return parseFloat(match[0].replace(/[x€$£\s,]/g, '')) || 0;
}

function parseBedroomsFromLine(primaryLine) {
  if (!primaryLine) return 1;
  const match = primaryLine.match(/(\d+)\s+bedroom/i);
  return match ? Math.min(parseInt(match[1]), 3) : 1;
}

// ─── Adapter ──────────────────────────────────────────────────────────────────
function adaptToMarketData(mcpResult, zoneName, weekLabel, monthLabel) {
  let listings = [];
  try {
    const text = mcpResult?.content?.[0]?.text;
    if (text) listings = JSON.parse(text).searchResults || [];
  } catch { return []; }

  if (!listings.length) return [];

  const byBeds = { 1: [], 2: [], 3: [] };
  listings.forEach(l => {
    const price = parseNightlyPrice(l?.structuredDisplayPrice?.explanationData?.priceDetails);
    const beds = parseBedroomsFromLine(l?.structuredContent?.primaryLine);
    if (price > 0) byBeds[Math.min(beds, 3)].push(price);
  });

  const results = [];
  for (let beds = 1; beds <= 3; beds++) {
    let prices = byBeds[beds];
    if (!prices.length) {
      const src = byBeds[beds - 1]?.length ? byBeds[beds - 1] : byBeds[1];
      const mult = beds === 2 ? 1.5 : 2.2;
      prices = (src || []).map(p => Math.round(p * mult));
    }
    if (!prices.length) continue;

    results.push({
      location: zoneName,
      beds,
      week: weekLabel,
      month: monthLabel,
      minPrice: Math.round(Math.min(...prices)),
      maxPrice: Math.round(Math.max(...prices)),
      avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
      availableCount: beds === 1 ? listings.length : Math.max(1, Math.round(listings.length / beds))
    });
  }
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

function getDateRangeForWeek(weekNumber, year = new Date().getFullYear()) {
  const jan4 = new Date(year, 0, 4);
  const dow = jan4.getDay() || 7;
  const weekStart = new Date(jan4);
  weekStart.setDate(jan4.getDate() - dow + 1 + (weekNumber - 1) * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  return {
    checkin: weekStart.toISOString().split('T')[0],
    checkout: weekEnd.toISOString().split('T')[0]
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
