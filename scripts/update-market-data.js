/**
 * Script de recopilación de datos de mercado para RevOptima.
 * Diseñado para ejecutarse en GitHub Actions o localmente.
 * Guarda los resultados en un JSON estático para el frontend.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// Configuración de Zonas
const ZONE_QUERIES = {
  'Playa de las Américas': 'Playa de las Americas, Tenerife, Spain',
  'Los Gigantes':          'Los Gigantes, Tenerife, Spain',
  'El Médano':             'El Medano, Tenerife, Spain',
  'Abades':                'Abades, Tenerife, Spain',
};

// Ruta del archivo de salida
const OUTPUT_PATH = path.join(__dirname, '..', 'revoptima-frontend', 'src', 'data', 'market-data.json');

// Helper para invocar el MCP
function callMcpTool(toolName, toolArgs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { mcpProcess.kill(); } catch {}
      reject(new Error(`MCP timeout for: ${toolName}`));
    }, 45000);

    const mcpProcess = spawn('npx', ['-y', '@openbnb/mcp-server-airbnb', '--ignore-robots-txt'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
    });

    let outputBuffer = '';
    let requestSent = false;

    const initRequest = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'revoptima-scraper', version: '1.0.0' } }
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

    mcpProcess.stderr.on('data', (data) => {
      // Opcional: console.error(data.toString());
    });

    mcpProcess.on('error', (err) => { clearTimeout(timeout); reject(err); });
    mcpProcess.stdin.write(initRequest);
  });
}

// Lógica de transformación
function parseNightlyPrice(priceDetails) {
  if (!priceDetails) return 0;
  // Regex para capturar números con símbolos de moneda, manejando formatos como "123 €", "€123", "1.234 €"
  const match = priceDetails.match(/([€$£]\s*[\d,.]+)|([\d,.]+\s*[€$£])/);
  if (!match) return 0;
  
  // Limpiar el string: quitar símbolos, espacios y convertir coma decimal si existe
  let cleanPrice = match[0].replace(/[€$£\s]/g, '').replace(',', '.');
  
  // Manejar miles (ej: 1.200 -> 1200) - Si el punto no es decimal
  if ((cleanPrice.match(/\./g) || []).length > 1 || (cleanPrice.includes('.') && cleanPrice.length - cleanPrice.indexOf('.') > 3)) {
    cleanPrice = cleanPrice.replace('.', '');
  }
  
  const price = parseFloat(cleanPrice);
  
  // Filtro de Realismo: Menos de 40€ en Tenerife suele ser un error de scraping (tasas) o una habitación compartida.
  // Como Otasa se enfoca en VV competitivas, precios de 10-20€ son ruido.
  return (price >= 40) ? price : 0;
}

function parseBedroomsFromLine(primaryLine) {
  if (!primaryLine) return 1;
  const match = primaryLine.match(/(\d+)\s+bedroom/i);
  return match ? Math.min(parseInt(match[1]), 3) : 1;
}

function adapt(mcpResult, zoneName, weekNum) {
  let listings = [];
  try {
    const text = mcpResult?.content?.[0]?.text;
    if (text) listings = JSON.parse(text).searchResults || [];
  } catch { return []; }

  const byBeds = { 1: [], 2: [], 3: [] };
  listings.forEach(l => {
    const price = parseNightlyPrice(l?.structuredDisplayPrice?.explanationData?.priceDetails);
    const beds = parseBedroomsFromLine(l?.structuredContent?.primaryLine);
    if (price > 0) byBeds[Math.min(beds, 3)].push(price);
  });

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
  const monthLabel = months[weekNum - 1] || 'Diciembre';

  const results = [];
  for (let beds = 1; beds <= 3; beds++) {
    let prices = byBeds[beds];
    if (!prices.length) {
      const src = byBeds[beds - 1]?.length ? byBeds[beds - 1] : byBeds[1];
      if (!src?.length) continue;
      const mult = beds === 2 ? 1.5 : 2.2;
      prices = src.map(p => Math.round(p * mult));
    }
    results.push({
      location: zoneName,
      beds,
      week: `Semana ${weekNum}`,
      month: monthLabel,
      minPrice: Math.round(Math.min(...prices)),
      maxPrice: Math.round(Math.max(...prices)),
      avgPrice: Math.round(prices.reduce((a, b) => a + b, 0) / prices.length),
      availableCount: beds === 1 ? listings.length : Math.max(1, Math.round(listings.length / beds))
    });
  }
  return results;
}

function getDateRangeForWeek(weekNumber) {
  const jan4 = new Date(new Date().getFullYear(), 0, 4);
  const weekStart = new Date(jan4);
  weekStart.setDate(jan4.getDate() - (jan4.getDay() || 7) + 1 + (weekNumber - 1) * 7);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  return { checkin: weekStart.toISOString().split('T')[0], checkout: weekEnd.toISOString().split('T')[0] };
}

// Ejecución Principal
async function main() {
  console.log('🚀 Iniciando actualización de datos históricos...');
  // Cargamos las 52 semanas del año para tener el histórico completo
  const weekNumbers = Array.from({ length: 52 }, (_, i) => i + 1);
  
  const allResults = [];
  
  for (const [zoneName, zoneQuery] of Object.entries(ZONE_QUERIES)) {
    for (const weekNum of weekNumbers) {
      try {
        console.log(`🔍 [${zoneName}] Semana ${weekNum}...`);
        const { checkin, checkout } = getDateRangeForWeek(weekNum);
        const mcpResult = await callMcpTool('airbnb_search', {
          location: zoneQuery, checkin, checkout, adults: 2, ignoreRobotsText: true
        });
        const adapted = adapt(mcpResult, zoneName, weekNum);
        allResults.push(...adapted);
        await new Promise(r => setTimeout(r, 600));
      } catch (err) {
        console.error(`❌ Error en ${zoneName} W${weekNum}: ${err.message}`);
      }
    }
  }

  // Asegurar directorio
  const dir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const finalOutput = {
    lastUpdate: new Date().toISOString(),
    count: allResults.length,
    data: allResults
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(finalOutput, null, 2));
  console.log(`✅ ¡Éxito! Guardados ${allResults.length} registros en ${OUTPUT_PATH}`);
}

main();
