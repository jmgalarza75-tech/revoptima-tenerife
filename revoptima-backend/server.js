/**
 * RevOptima Backend — API Bridge
 * 
 * Este servidor actúa como capa intermedia (bridge) entre el frontend 
 * React y el servidor MCP de Airbnb (@openbnb/mcp-server-airbnb).
 * 
 * El MCP Server comunica via stdio (no HTTP), por lo que este bridge 
 * lanza el proceso como child_process, envía comandos MCP y devuelve
 * los datos transformados al formato esperado por marketData del frontend.
 * 
 * Arquitectura:
 *   React (fetch) --> Bridge Express (puerto 3001) --> MCP stdio --> Airbnb
 */

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const app = express();
const PORT = 3001;

const ALLOWED_ORIGINS = ['http://localhost:5173', 'http://localhost:5174'];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  }
}));
app.use(express.json());

// ─── Zones Config ─────────────────────────────────────────────────────────────
// Mapeo de los nombres de zona del dashboard a queries de búsqueda de Airbnb
const ZONE_QUERIES = {
  'Playa de las Américas': 'Playa de las Americas, Tenerife, Spain',
  'Los Gigantes':          'Los Gigantes, Tenerife, Spain',
  'El Médano':             'El Medano, Tenerife, Spain',
  'Abades':                'Abades, Tenerife, Spain',
};

// ─── MCP Client Helper ────────────────────────────────────────────────────────
/**
 * Lanza el proceso MCP de Airbnb, envía una petición JSON-RPC y devuelve 
 * la respuesta parseada. Cierra el proceso al terminar.
 */
function callMcpTool(toolName, toolArgs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      mcpProcess.kill();
      reject(new Error(`MCP tool call timed out after 30s for tool: ${toolName}`));
    }, 30000);

    const mcpProcess = spawn('npx', ['-y', '@openbnb/mcp-server-airbnb', '--ignore-robots-txt'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let outputBuffer = '';
    let initialized = false;
    let requestSent = false;
    const REQUEST_ID = 2;

    // Inicialización MCP: primero debemos hacer "initialize" y luego la tool call
    const initRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'revoptima-bridge', version: '1.0.0' }
      }
    }) + '\n';

    const toolRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: REQUEST_ID,
      method: 'tools/call',
      params: { name: toolName, arguments: toolArgs }
    }) + '\n';

    mcpProcess.stdout.on('data', (data) => {
      outputBuffer += data.toString();
      
      // Procesamos línea a línea (el protocolo MCP usa newline-delimited JSON)
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop(); // Guardamos línea incompleta

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          
          // Respuesta de initialize -> enviamos el tool call
          if (parsed.id === 1 && !requestSent) {
            // Enviar notificación initialized
            mcpProcess.stdin.write(JSON.stringify({
              jsonrpc: '2.0',
              method: 'notifications/initialized',
              params: {}
            }) + '\n');
            // Enviar el tool call real
            mcpProcess.stdin.write(toolRequest);
            requestSent = true;
          }

          // Respuesta del tool call
          if (parsed.id === REQUEST_ID) {
            clearTimeout(timeout);
            mcpProcess.kill();
            if (parsed.error) {
              reject(new Error(parsed.error.message));
            } else {
              resolve(parsed.result);
            }
          }
        } catch (e) {
          // Ignorar líneas no-JSON (logs del servidor)
        }
      }
    });

    mcpProcess.stderr.on('data', (data) => {
      // Los logs del MCP server van a stderr — ignoramos para no mezclar con stdio
      // console.error('[MCP stderr]', data.toString());
    });

    mcpProcess.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`Failed to spawn MCP process: ${err.message}`));
    });

    mcpProcess.on('close', (code) => {
      clearTimeout(timeout);
      if (code !== 0 && code !== null) {
        reject(new Error(`MCP process exited with code ${code}`));
      }
    });

    // Enviamos el initialize en cuanto el proceso está listo
    mcpProcess.stdin.write(initRequest);
  });
}

// ─── Adapter: MCP → marketData ────────────────────────────────────────────────
/**
 * Parsea el precio por noche desde el string de detalle de Airbnb.
 * Ejemplo input: "7 nights x € 189.35: € 1,325.48, Weekly stay discount: ..."
 * Devuelve el precio por noche como número entero.
 */
function parseNightlyPrice(priceDetails) {
  if (!priceDetails) return 0;
  // Captura el precio por noche: "x € 189.35" o "x $189.35"
  const match = priceDetails.match(/x\s*[€$£]\s*[\d,]+\.?\d*/);
  if (!match) return 0;
  const priceStr = match[0].replace(/[x€$£\s,]/g, '').trim();
  return parseFloat(priceStr) || 0;
}

/**
 * Extrae el número de dormitorios desde el primaryLine del structuredContent.
 * Ejemplo: "2 bedrooms, 2 beds" → 2 | "1 bedroom, 1 queen bed" → 1
 */
function parseBedroomsFromLine(primaryLine) {
  if (!primaryLine) return 1;
  const match = primaryLine.match(/(\d+)\s+bedroom/i);
  if (match) return Math.min(parseInt(match[1]), 3);
  // Studio o sin mención → 1 dormitorio
  return 1;
}

/**
 * Transforma los resultados crudos del MCP de Airbnb al formato exacto
 * que consume el estado marketData del frontend:
 * { location, beds, week, month, minPrice, maxPrice, avgPrice, availableCount }
 */
function adaptMcpResultsToMarketData(mcpResult, zoneName, targetWeek, weekLabel, monthLabel) {
  let listings = [];
  try {
    const content = mcpResult?.content?.[0]?.text;
    if (content) {
      const parsed = JSON.parse(content);
      listings = parsed.searchResults || [];
    }
  } catch (e) {
    console.error('[Adapter] Error parsing MCP content:', e.message);
    return [];
  }

  if (listings.length === 0) return [];

  // Agrupamos precios por noche según número de habitaciones
  const byBeds = { 1: [], 2: [], 3: [] };

  listings.forEach(listing => {
    const priceDetails = listing?.structuredDisplayPrice?.explanationData?.priceDetails;
    const primaryLine = listing?.structuredContent?.primaryLine || '';

    const nightlyPrice = parseNightlyPrice(priceDetails);
    const beds = parseBedroomsFromLine(primaryLine);

    if (nightlyPrice > 0) {
      // Agrupamos en la categoría correcta (máximo 3)
      const key = Math.min(beds, 3);
      byBeds[key].push(nightlyPrice);
    }
  });

  const results = [];

  for (let beds = 1; beds <= 3; beds++) {
    let prices = byBeds[beds];

    // Si no hay datos para este segmento, estimamos desde el nivel inferior con multiplicador
    if (prices.length === 0) {
      const lowerPrices = byBeds[beds - 1] || byBeds[1] || [];
      if (lowerPrices.length > 0) {
        const multiplier = beds === 2 ? 1.5 : 2.2;
        prices = lowerPrices.map(p => Math.round(p * multiplier));
      }
    }

    if (prices.length === 0) continue;

    const avgPrice = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
    const minPrice = Math.round(Math.min(...prices));
    const maxPrice = Math.round(Math.max(...prices));
    // Estimamos el número de anuncios activos proporcional al segmento
    const availableCount = beds === 1
      ? listings.length
      : Math.max(1, Math.round(listings.length / beds));

    results.push({
      location: zoneName,
      beds,
      week: weekLabel,
      month: monthLabel,
      minPrice,
      maxPrice,
      avgPrice,
      availableCount
    });
  }

  console.log(`[Adapter] ${zoneName} ${weekLabel}: ${listings.length} listings → ${results.length} registros`);
  return results;
}


// ─── Week/Month Utilities ─────────────────────────────────────────────────────
function getMonthFromWeek(week) {
  if (week < 18) return 'Abril';
  if (week < 22) return 'Mayo';
  if (week < 27) return 'Junio';
  if (week < 31) return 'Julio';
  if (week < 36) return 'Agosto';
  if (week < 40) return 'Septiembre';
  if (week < 45) return 'Octubre';
  if (week < 49) return 'Noviembre';
  return 'Diciembre';
}

function getDateRangeForWeek(weekNumber, year = new Date().getFullYear()) {
  // ISO week to date
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const weekStart = new Date(jan4);
  weekStart.setDate(jan4.getDate() - dayOfWeek + 1 + (weekNumber - 1) * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  const checkin = weekStart.toISOString().split('T')[0];
  const checkout = weekEnd.toISOString().split('T')[0];
  return { checkin, checkout };
}

// ─── API Routes ───────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'RevOptima Bridge', timestamp: new Date().toISOString() });
});

/**
 * GET /api/market-data
 * 
 * Parámetros opcionales:
 *   ?location=Los Gigantes   (filtrar por zona)
 *   ?weeks=14,15,16          (semanas específicas, por defecto 14-20)
 *   ?beds=2                  (habitaciones, por defecto todas)
 * 
 * Devuelve: Array de marketData compatible con el estado del frontend
 */
app.get('/api/market-data', async (req, res) => {
  const { location, weeks, beds } = req.query;
  
  // Zonas a consultar
  const zonesToQuery = location && ZONE_QUERIES[location]
    ? { [location]: ZONE_QUERIES[location] }
    : ZONE_QUERIES;
  
  // Semanas a consultar (por defecto las próximas 6 semanas desde la actual)
  const currentWeek = Math.ceil((new Date() - new Date(new Date().getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000));
  let weekNumbers;
  if (weeks) {
    weekNumbers = weeks.split(',').map(Number).filter(w => w >= 1 && w <= 52);
  } else {
    // Por defecto: próximas 4 semanas para que la respuesta sea rápida (< 15s)
    weekNumbers = Array.from({ length: 4 }, (_, i) => Math.min(currentWeek + i, 52));
  }

  const allResults = [];
  const errors = [];

  // Consultamos cada zona + semana en paralelo (con límite de concurrencia)
  for (const [zoneName, zoneQuery] of Object.entries(zonesToQuery)) {
    for (const weekNum of weekNumbers) {
      try {
        const { checkin, checkout } = getDateRangeForWeek(weekNum);
        const weekLabel = `Semana ${weekNum}`;
        const monthLabel = getMonthFromWeek(weekNum);

        console.log(`[Bridge] Querying MCP: zone="${zoneName}" week=${weekNum} checkin=${checkin} checkout=${checkout}`);

        const mcpResult = await callMcpTool('airbnb_search', {
          location: zoneQuery,
          checkin,
          checkout,
          adults: 2,
          ignoreRobotsText: true
        });

        const adapted = adaptMcpResultsToMarketData(mcpResult, zoneName, weekNum, weekLabel, monthLabel);
        allResults.push(...adapted);

        // Pequeña pausa para no saturar Airbnb (rate limiting cortés)
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        console.error(`[Bridge] Error for zone="${zoneName}" week=${weekNum}:`, err.message);
        errors.push({ zone: zoneName, week: weekNum, error: err.message });
      }
    }
  }

  res.json({
    success: true,
    count: allResults.length,
    errors: errors.length > 0 ? errors : undefined,
    data: allResults
  });
});

/**
 * GET /api/market-data/full-year
 * 
 * Consulta todas las semanas desde Abril (14) hasta Diciembre (52).
 * Operación pesada — recomendado lanzarla una vez al día y cachear.
 */
app.get('/api/market-data/full-year', async (req, res) => {
  // Redirigimos con todas las semanas del año
  const allWeeks = Array.from({ length: 39 }, (_, i) => i + 14).join(',');
  req.query.weeks = allWeeks;
  // Delegamos al handler principal (llamamos directamente la lógica)
  res.redirect(`/api/market-data?weeks=${allWeeks}${req.query.location ? `&location=${req.query.location}` : ''}`);
});

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ┌─────────────────────────────────────────────┐
  │   RevOptima Backend — API Bridge v1.0        │
  │   http://localhost:${PORT}                     │
  │                                              │
  │   MCP Server: @openbnb/mcp-server-airbnb     │
  │   Zonas: Las Américas, Los Gigantes,         │
  │           El Médano, Abades                  │
  └─────────────────────────────────────────────┘
  `);
});
