const fs = require('fs');
const path = require('path');

async function downloadCsv(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  return await response.text();
}

function parseIstacCsv(csvText, measureName) {
  const lines = csvText.split('\n');
  const results = {};
  
  // Headers: TERRITORIO,TERRITORIO_CODE,TIME_PERIOD,TIME_PERIOD_CODE,INTERVALOS_PLAZAS,INTERVALOS_PLAZAS_CODE,MEDIDAS,MEDIDAS_CODE,OBS_VALUE...
  lines.slice(1).forEach(line => {
    const cols = line.split(',');
    if (cols.length < 9) return;
    
    const territory = cols[0];
    const periodStr = cols[2]; // 01/2026
    const measure = cols[6];
    const value = parseFloat(cols[8]);
    const intervals = cols[4];
    
    // Filtramos por Tenerife y Total
    if (territory.includes('Tenerife') && intervals.includes('Total') && measure.includes(measureName)) {
      const [month, year] = periodStr.split('/');
      const monthName = getMonthName(parseInt(month));
      
      if (!results[year]) results[year] = {};
      results[year][monthName] = value;
    }
  });
  return results;
}

function getMonthName(m) {
  const names = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  return names[m - 1];
}

async function main() {
  try {
    console.log('📊 Extrayendo datos oficiales de ISTAC...');
    
    const adrCsv = await downloadCsv('https://datos.canarias.es/api/estadisticas/statistical-resources/v1.0/datasets/ISTAC/C00065A_000062/~latest.csv');
    const occCsv = await downloadCsv('https://datos.canarias.es/api/estadisticas/statistical-resources/v1.0/datasets/ISTAC/C00065A_000061/~latest.csv');
    
    const adrData = parseIstacCsv(adrCsv, 'Tarifa media diaria');
    const occData = parseIstacCsv(occCsv, 'Tasa de vivienda reservada');
    
    const finalData = {
      lastUpdate: new Date().toISOString(),
      adr: adrData,
      occupancy: occData
    };
    
    const outputPath = path.join(__dirname, '../revoptima-frontend/src/data/istac-data.json');
    fs.writeFileSync(outputPath, JSON.stringify(finalData, null, 2));
    
    console.log('✅ Datos de ISTAC actualizados en:', outputPath);
  } catch (error) {
    console.error('❌ Error actualizando ISTAC:', error);
  }
}

main();
