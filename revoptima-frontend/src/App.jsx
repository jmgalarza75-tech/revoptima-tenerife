import React, { useState, useMemo, useEffect } from 'react';
import { BarChart2, MapPin, BedDouble, CalendarDays, TrendingUp, Info, Building, LineChart, FileSpreadsheet, Clock, Home } from 'lucide-react';

// Generador de datos simulados para el prototipo (Semanas de Abril a Diciembre)
const generateMockData = () => {
  const locations = [
    { name: 'Playa de las Américas', basePrice: 120, volatility: 40, baseCount: 150 },
    { name: 'Los Gigantes', basePrice: 90, volatility: 20, baseCount: 80 },
    { name: 'El Médano', basePrice: 100, volatility: 30, baseCount: 110 },
    { name: 'Abades', basePrice: 70, volatility: 15, baseCount: 30 }
  ];
  
  const data = [];
  const startWeek = 14; // Aprox Abril
  const endWeek = 52; // Fin de año

  locations.forEach(loc => {
    for (let beds = 1; beds <= 3; beds++) {
      for (let week = startWeek; week <= endWeek; week++) {
        // Simulamos estacionalidad (alta en verano y en invierno para Canarias)
        const seasonality = (week > 28 && week < 35) || (week > 48) ? 1.4 : 1.0;
        const bedMultiplier = beds === 1 ? 1 : beds === 2 ? 1.5 : 2.2;
        
        const avgPrice = Math.round(loc.basePrice * bedMultiplier * seasonality + (Math.random() * loc.volatility));
        const minPrice = Math.round(avgPrice * 0.7);
        const maxPrice = Math.round(avgPrice * 1.5);
        // El número de apartamentos disponibles baja en temporada alta
        const availableCount = Math.round((loc.baseCount / beds) * (2 - seasonality) * (0.8 + Math.random() * 0.4));

        data.push({
          location: loc.name,
          beds: beds,
          week: `Semana ${week}`,
          month: getMonthFromWeek(week),
          minPrice,
          maxPrice,
          avgPrice,
          availableCount
        });
      }
    }
  });
  return data;
};

const getMonthFromWeek = (week) => {
  const months = ['Abril','Abril','Abril','Abril','Mayo','Mayo','Mayo','Mayo',
                  'Junio','Junio','Junio','Junio','Junio','Julio','Julio','Julio',
                  'Julio','Agosto','Agosto','Agosto','Agosto','Agosto','Septiembre',
                  'Septiembre','Septiembre','Septiembre','Octubre','Octubre','Octubre',
                  'Octubre','Octubre','Noviembre','Noviembre','Noviembre','Noviembre',
                  'Diciembre','Diciembre','Diciembre','Diciembre'];
  if (week < 14) return 'Abril';
  return months[week - 14] || 'Diciembre';
};

export default function App() {
  const [selectedLocation, setSelectedLocation] = useState('Todas');
  const [selectedBeds, setSelectedBeds] = useState('Todos');
  const [selectedType, setSelectedType] = useState('Apartamento'); // 'Apartamento' o 'Habitación'
  const [selectedStay, setSelectedStay] = useState('7');
  const [selectedMonth, setSelectedMonth] = useState('Todos');
  const [hoveredData, setHoveredData] = useState(null);
  const [marketData, setMarketData] = useState([]);
  const [isLoading, setIsLoading] = useState(true);

  // Función para exportar a CSV (Compatible con Google Sheets)
  const exportToCsv = () => {
    if (marketData.length === 0) return;

    // Cabeceras estructuradas para base de datos
    const headers = ['Fecha_Captura', 'Zona', 'Tipo', 'Dormitorios', 'Semana', 'Mes', 'Precio_Minimo', 'Precio_Medio', 'Precio_Maximo', 'Oferta_Activa'];
    
    // Añadimos el "timestamp" para crear el histórico
    const today = new Date().toISOString().split('T')[0];
    
    const rows = marketData.map(item => [
      today,
      item.location,
      item.type || 'Apartamento',
      item.beds,
      item.week,
      item.month,
      item.minPrice,
      item.avgPrice,
      item.maxPrice,
      item.availableCount
    ]);

    const csvContent = [
      headers.join(','),
      ...rows.map(e => e.join(','))
    ].join('\n');

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `Historico_Tenerife_${today}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const hasLoadedRef = React.useRef(false);
  const [lastUpdate, setLastUpdate] = useState(null);

  // Integración con el MCP Server y Datos Estáticos
  useEffect(() => {
    const fetchMcpData = async () => {
      setIsLoading(true);
      try {
        // 1. Intentamos cargar primero los datos estáticos (GitHub Actions)
        // Esto es instantáneo y gratuito
        try {
          const staticData = await import('./data/market-data.json');
          if (staticData && staticData.data && staticData.data.length > 0) {
            console.log(`[RevOptima] Datos estáticos cargados: ${staticData.count} registros`);
            setMarketData(staticData.data);
            setLastUpdate(staticData.lastUpdate);
            hasLoadedRef.current = true;
            
            // Si los datos estáticos ya cubren la zona seleccionada, terminamos aquí
            if (selectedLocation === 'Todas' || staticData.data.some(d => d.location === selectedLocation)) {
              setIsLoading(false);
              return;
            }
          }
        } catch {
          console.log('[RevOptima] No se encontraron datos estáticos, consultando API...');
        }

        // 2. Si no hay datos estáticos o falta una zona, consultamos la API (Vercel)
        const apiBase = import.meta.env.PROD
          ? '/api/market-data'
          : 'http://localhost:3001/api/market-data';

        const params = new URLSearchParams();
        if (selectedLocation !== 'Todas') params.append('location', selectedLocation);
        
        const url = `${apiBase}${params.toString() ? '?' + params.toString() : ''}`;
        console.log(`[RevOptima] Fetching live data from: ${url}`);
        
        const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
        if (!response.ok) throw new Error(`API error ${response.status}`);
        const json = await response.json();

        if (json.success && Array.isArray(json.data) && json.data.length > 0) {
          console.log(`[RevOptima] Datos reales (API) cargados: ${json.count} registros`);
          hasLoadedRef.current = true;
          setMarketData(prev => {
            if (selectedLocation === 'Todas') return json.data;
            const otherZones = prev.filter(d => d.location !== selectedLocation);
            return [...otherZones, ...json.data];
          });
        }
      } catch (err) {
        console.warn('[RevOptima] Error fetching data:', err.message);
        if (!hasLoadedRef.current) {
          setMarketData(generateMockData());
          hasLoadedRef.current = true;
        }
      } finally {
        setIsLoading(false);
      }
    };

    fetchMcpData();
  }, [selectedLocation]);

  // Filtrado de datos y aplicación de estrategia de precios por Length of Stay (LOS)
  const filteredData = useMemo(() => {
    const stayDays = parseInt(selectedStay);
    
    // Curva de descuento/premium por duración de estancia (LOS Strategy)
    // Asumimos que el precio base devuelto por el MCP Server es semanal (7 días)
    const losMultiplier = 
      stayDays === 1 ? (1/7) * 1.25 :   // 1 noche: +25% de recargo sobre el prorrateo semanal
      stayDays === 5 ? (5/7) * 1.05 :   // 5 días: +5% de recargo
      stayDays === 7 ? 1 :              // 7 días: Base
      stayDays === 15 ? (15/7) * 0.90 : // 15 días: -10%
      (30/7) * 0.75;                    // 30 días: -25%

    return marketData.filter(item => {
      const matchLocation = selectedLocation === 'Todas' || item.location === selectedLocation;
      const matchBeds = selectedBeds === 'Todos' || item.beds === parseInt(selectedBeds);
      const matchMonth = selectedMonth === 'Todos' || item.month === selectedMonth;
      const matchType = (item.type || 'Apartamento') === selectedType;
      return matchLocation && matchBeds && matchMonth && matchType;
    }).map(item => ({
      ...item,
      minPrice: Math.round(item.minPrice * losMultiplier),
      avgPrice: Math.round(item.avgPrice * losMultiplier),
      maxPrice: Math.round(item.maxPrice * losMultiplier)
    }));
  }, [selectedLocation, selectedBeds, selectedStay, selectedMonth, selectedType, marketData]);

  // Agrupación por semana para la vista principal
  const weeklyAggregatedData = useMemo(() => {
    const grouped = {};
    filteredData.forEach(item => {
      if (!grouped[item.week]) {
        grouped[item.week] = { week: item.week, month: item.month, minPrices: [], maxPrices: [], avgPrices: [], totalCount: 0 };
      }
      grouped[item.week].minPrices.push(item.minPrice);
      grouped[item.week].maxPrices.push(item.maxPrice);
      grouped[item.week].avgPrices.push(item.avgPrice);
      grouped[item.week].totalCount += item.availableCount;
    });

    const items = Object.values(grouped).map(group => {
      const sortedMedian = [...group.avgPrices].sort((a, b) => a - b);
      const mid = Math.floor(sortedMedian.length / 2);
      const median = sortedMedian.length % 2 !== 0 ? sortedMedian[mid] : (sortedMedian[mid - 1] + sortedMedian[mid]) / 2;

      return {
        week: group.week,
        month: group.month,
        minPrice: Math.min(...group.minPrices),
        maxPrice: Math.max(...group.maxPrices),
        avgPrice: Math.round(median), // Usamos la mediana como "Referencia Real"
        totalCount: group.totalCount
      };
    });

    // Añadir tendencia comparando con la semana anterior
    return items.map((item, index) => {
      const prev = items[index - 1];
      const trend = prev ? (item.avgPrice > prev.avgPrice ? 'up' : (item.avgPrice < prev.avgPrice ? 'down' : 'stable')) : 'stable';
      return { ...item, trend };
    });
  }, [filteredData]);

  // KPIs Globales
  const kpis = useMemo(() => {
    if (weeklyAggregatedData.length === 0) {
      return { min: 0, max: 0, avg: 0, avgCount: 0, occupancy: 0, pressure: 'Baja' };
    }
    
    const min = Math.min(...weeklyAggregatedData.map(d => d.minPrice));
    const max = Math.max(...weeklyAggregatedData.map(d => d.maxPrice));
    const avg = Math.round(weeklyAggregatedData.reduce((acc, curr) => acc + curr.avgPrice, 0) / weeklyAggregatedData.length);
    const avgCount = Math.round(weeklyAggregatedData.reduce((acc, curr) => acc + curr.totalCount, 0) / weeklyAggregatedData.length);
    
    // Lógica simulada de negocio
    const occupancy = Math.min(98, Math.round(65 + (avg / 25))); 
    const pressure = avgCount > 120 ? 'Alta' : (avgCount > 60 ? 'Media' : 'Baja');

    return { min, max, avg, avgCount, occupancy, pressure };
  }, [weeklyAggregatedData]);

  // Configuraciones del gráfico de líneas SVG
  const chartHeight = 220;
  const chartWidth = 1000;
  const maxPriceInChart = weeklyAggregatedData.length > 0 
    ? Math.max(...weeklyAggregatedData.map(d => d.maxPrice)) * 1.1 
    : 100;

  const generatePath = (key) => {
    if (weeklyAggregatedData.length === 0) return "";
    return weeklyAggregatedData.map((d, i) => {
      const x = (i / (weeklyAggregatedData.length - 1)) * chartWidth;
      const y = chartHeight - (d[key] / maxPriceInChart) * chartHeight;
      return `${x},${y}`;
    }).join(' ');
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800 font-sans">
      {/* Header */}
      <header className="bg-slate-900 text-white p-6 shadow-md">
        <div className="max-w-7xl mx-auto flex flex-col lg:flex-row justify-between items-start lg:items-center gap-6">
          <div>
            <h1 className="text-2xl font-black flex items-center gap-2">
              <TrendingUp className="text-emerald-400 w-8 h-8" />
              RevOptima <span className="text-slate-400 font-light">Tenerife</span>
            </h1>
            <div className="flex flex-col sm:flex-row sm:items-center gap-4 mt-1">
              <p className="text-slate-400 text-sm font-medium">Inteligencia de Precios por Noche — VV Tenerife</p>
              
              <div className="flex items-center gap-2">
                <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold bg-slate-800 px-2.5 py-1 rounded-full text-emerald-400 border border-slate-700 w-max">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></div>
                  MCP Server: Conectado
                </span>
                
                <span className={`flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-bold bg-slate-800 px-2.5 py-1 rounded-full border border-slate-700 ${kpis.occupancy > 75 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  Sentido Mercado: {kpis.occupancy > 75 ? 'Alcista' : 'Estable'}
                </span>

                {lastUpdate && (
                  <span className="text-[10px] text-slate-500 font-medium bg-slate-800/50 px-2.5 py-1 rounded-full border border-slate-700/50">
                    Sinc: {new Date(lastUpdate).toLocaleDateString()}
                  </span>
                )}
              </div>
            </div>
          </div>
          
          <div className="flex flex-wrap items-center gap-4">
            {/* Filtros */}
            <div className="flex flex-wrap gap-3">
              <div className="bg-slate-800 rounded-lg p-1 flex items-center border border-slate-700">
                <MapPin className="w-4 h-4 text-slate-400 ml-2" />
                <select 
                  className="bg-transparent text-white border-none focus:ring-0 text-sm p-2 outline-none"
                  value={selectedLocation}
                  onChange={(e) => setSelectedLocation(e.target.value)}
                >
                  <option value="Todas">Todas las Zonas</option>
                  <option value="Playa de las Américas">Playa de las Américas</option>
                  <option value="Los Gigantes">Los Gigantes</option>
                  <option value="El Médano">El Médano</option>
                  <option value="Abades">Abades</option>
                </select>
              </div>

              <div className="bg-slate-800 rounded-lg p-1 flex items-center border border-slate-700">
                <Home className="w-4 h-4 text-slate-400 ml-2" />
                <select 
                  className="bg-transparent text-white border-none focus:ring-0 text-sm p-2 outline-none font-bold"
                  value={selectedType}
                  onChange={(e) => setSelectedType(e.target.value)}
                >
                  <option value="Apartamento">Apartamento / Piso</option>
                  <option value="Habitación">Habitación Privada</option>
                  <option value="Villa">Villa / Casa / Chalet</option>
                  <option value="Cama">Cama / Hab. Compartida</option>
                </select>
              </div>

              <div className="bg-slate-800 rounded-lg p-1 flex items-center border border-slate-700">
                <BedDouble className="w-4 h-4 text-slate-400 ml-2" />
                <select 
                  className="bg-transparent text-white border-none focus:ring-0 text-sm p-2 outline-none"
                  value={selectedBeds}
                  onChange={(e) => setSelectedBeds(e.target.value)}
                >
                  <option value="Todos">Todas las Hab.</option>
                  <option value="1">1 Dormitorio</option>
                  <option value="2">2 Dormitorios</option>
                  <option value="3">3 Dormitorios</option>
                </select>
              </div>

              <div className="bg-slate-800 rounded-lg p-1 flex items-center border border-slate-700">
                <CalendarDays className="w-4 h-4 text-slate-400 ml-2" />
                <select 
                  className="bg-transparent text-white border-none focus:ring-0 text-sm p-2 outline-none"
                  value={selectedMonth}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                >
                  <option value="Todos">Todo el Año</option>
                  {['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'].map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>

              <div className="bg-slate-800 rounded-lg p-1 flex items-center border border-slate-700">
                <Clock className="w-4 h-4 text-slate-400 ml-2" />
                <select 
                  className="bg-transparent text-white border-none focus:ring-0 text-sm p-2 outline-none"
                  value={selectedStay}
                  onChange={(e) => setSelectedStay(e.target.value)}
                >
                  <option value="1">Estancia: 1 Noche</option>
                  <option value="5">Estancia: 5 Días</option>
                  <option value="7">Estancia: 7 Días</option>
                  <option value="15">Estancia: 15 Días</option>
                  <option value="30">Estancia: 1 Mes</option>
                </select>
              </div>
            </div>

            {/* Botón Exportar */}
            <button 
              onClick={exportToCsv}
              disabled={isLoading}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2.5 rounded-xl text-sm font-bold transition-all disabled:opacity-50 disabled:cursor-not-allowed border border-emerald-400/50 shadow-lg shadow-emerald-900/20 active:scale-95"
            >
              <FileSpreadsheet className="w-4 h-4" />
              <span className="hidden sm:inline">Exportar Inteligencia</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-6">
        
        {isLoading ? (
          <div className="space-y-8 animate-pulse">
            {/* KPI Skeletons */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6">
              {[1, 2, 3, 4].map(i => (
                <div key={i} className="bg-slate-100 h-32 rounded-2xl border border-slate-200"></div>
              ))}
            </div>
            {/* Chart Skeleton */}
            <div className="bg-slate-100 h-80 rounded-3xl border border-slate-200"></div>
            {/* Table Skeleton */}
            <div className="bg-white rounded-3xl border border-slate-100 overflow-hidden shadow-sm">
              <div className="h-16 bg-slate-50 border-b border-slate-100"></div>
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="h-20 bg-white border-b border-slate-50"></div>
              ))}
            </div>
            <p className="text-center text-slate-400 text-sm font-medium">Sincronizando con base de datos de inteligencia...</p>
          </div>
        ) : (
          <>
            {/* KPIs Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-8">
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col relative overflow-hidden group hover:shadow-md transition-shadow">
                <div className="absolute top-0 right-0 w-24 h-24 bg-slate-50 rounded-full -mr-12 -mt-12 transition-transform group-hover:scale-110"></div>
                <span className="text-slate-500 text-xs font-bold uppercase tracking-wider flex items-center gap-1 z-10">
                  Suelo Mercado <Info className="w-3 h-3" />
                </span>
                <span className="text-4xl font-black text-slate-800 mt-3 z-10">{kpis.min}€</span>
                <span className="text-[10px] text-slate-400 mt-2 font-medium z-10 uppercase tracking-tighter">Mínimo detectado ({selectedStay} días)</span>
              </div>
              
              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col relative overflow-hidden group hover:shadow-md transition-shadow">
                <div className="absolute top-0 right-0 w-24 h-24 bg-blue-50 rounded-full -mr-12 -mt-12 transition-transform group-hover:scale-110"></div>
                <span className="text-blue-500 text-xs font-bold uppercase tracking-wider flex items-center gap-1 z-10">
                  ADR Competitivo <Info className="w-3 h-3" />
                </span>
                <span className="text-4xl font-black text-blue-600 mt-3 z-10">{kpis.avg}€</span>
                <span className="text-[10px] text-blue-400 mt-2 font-medium z-10 uppercase tracking-tighter">Media de mercado ({selectedStay} días)</span>
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col relative overflow-hidden group hover:shadow-md transition-shadow">
                <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-50 rounded-full -mr-12 -mt-12 transition-transform group-hover:scale-110"></div>
                <span className="text-emerald-500 text-xs font-bold uppercase tracking-wider flex items-center gap-1 z-10">
                  Techo Tarifario <Info className="w-3 h-3" />
                </span>
                <span className="text-4xl font-black text-emerald-600 mt-3 z-10">{kpis.max}€</span>
                <span className="text-[10px] text-emerald-400 mt-2 font-medium z-10 uppercase tracking-tighter">Máximo detectado ({selectedStay} días)</span>
              </div>

              <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col relative overflow-hidden group hover:shadow-md transition-shadow">
                <div className="absolute top-0 right-0 w-24 h-24 bg-indigo-50 rounded-full -mr-12 -mt-12 transition-transform group-hover:scale-110"></div>
                <span className="text-indigo-500 text-xs font-bold uppercase tracking-wider flex items-center gap-1 z-10">
                  Densidad Oferta <Building className="w-3 h-3" />
                </span>
                <span className="text-4xl font-black text-indigo-600 mt-3 z-10">{kpis.avgCount}</span>
                <span className="text-[10px] text-indigo-400 mt-2 font-medium z-10 uppercase tracking-tighter">Unidades activas promedio</span>
              </div>
            </div>

        {/* Chart Prototipo */}
        <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100 mb-8 relative">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center mb-6 gap-4">
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <LineChart className="w-5 h-5 text-blue-500" />
              Evolución de Bandas de Precios
            </h2>
            <div className="flex gap-4 text-sm font-medium">
              <span className="flex items-center gap-1 text-emerald-600"><div className="w-3 h-3 rounded-full bg-emerald-500"></div> Máximo</span>
              <span className="flex items-center gap-1 text-blue-600"><div className="w-3 h-3 rounded-full bg-blue-500"></div> Medio</span>
              <span className="flex items-center gap-1 text-slate-500"><div className="w-3 h-3 rounded-full bg-slate-400"></div> Mínimo</span>
            </div>
          </div>
          
          <div className="relative w-full overflow-x-auto pb-4">
            <div className="min-w-[700px] h-[280px] relative">
               <svg viewBox={`0 0 ${chartWidth} ${chartHeight + 40}`} className="w-full h-full overflow-visible">
                  {/* Grid lines horizontales (referencias de precio) */}
                  {[0, 0.25, 0.5, 0.75, 1].map(ratio => {
                    const yPos = chartHeight * ratio;
                    const priceLabel = Math.round(maxPriceInChart - (maxPriceInChart * ratio));
                    return (
                      <g key={ratio}>
                        <line x1="0" y1={yPos} x2={chartWidth} y2={yPos} stroke="#f1f5f9" strokeDasharray="4 4" />
                        <text x="0" y={yPos - 5} fontSize="10" fill="#94a3b8">{priceLabel}€</text>
                      </g>
                    );
                  })}
                  
                  {/* Defs for gradients */}
                  <defs>
                    <linearGradient id="gradBlue" x1="0%" y1="0%" x2="0%" y2="100%">
                      <stop offset="0%" style={{ stopColor: '#3b82f6', stopOpacity: 0.2 }} />
                      <stop offset="100%" style={{ stopColor: '#3b82f6', stopOpacity: 0 }} />
                    </linearGradient>
                  </defs>

                  {/* Área sombreada bajo la línea media */}
                  <path d={`M 0 ${chartHeight} L ${generatePath('avgPrice')} L ${chartWidth} ${chartHeight} Z`} fill="url(#gradBlue)" />
                  
                  {/* Líneas de Precios con efecto de brillo */}
                  <polyline points={generatePath('maxPrice')} fill="none" stroke="#10b981" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 4px rgba(16,185,129,0.2))' }} />
                  <polyline points={generatePath('avgPrice')} fill="none" stroke="#3b82f6" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" style={{ filter: 'drop-shadow(0 0 8px rgba(59,130,246,0.3))' }} />
                  <polyline points={generatePath('minPrice')} fill="none" stroke="#94a3b8" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" opacity="0.6" />

                  {/* Áreas de interacción (Hover) */}
                  {weeklyAggregatedData.map((d, i) => {
                    const x = (i / (weeklyAggregatedData.length - 1)) * chartWidth;
                    return (
                      <g key={i} className="group cursor-pointer">
                        {/* Barra invisible para detectar el ratón */}
                        <rect x={x - (chartWidth / weeklyAggregatedData.length / 2)} y="0" width={chartWidth / weeklyAggregatedData.length} height={chartHeight} fill="transparent" 
                          onMouseEnter={() => setHoveredData(d)}
                          onMouseLeave={() => setHoveredData(null)}
                        />
                        {/* Línea vertical que aparece al pasar el ratón */}
                        <line x1={x} y1="0" x2={x} y2={chartHeight} stroke="#cbd5e1" strokeWidth="2" className="opacity-0 group-hover:opacity-100 transition-opacity" />
                        
                        {/* Puntos de intersección en hover */}
                        <circle cx={x} cy={chartHeight - (d.maxPrice / maxPriceInChart) * chartHeight} r="4" fill="#10b981" className="opacity-0 group-hover:opacity-100 transition-opacity" />
                        <circle cx={x} cy={chartHeight - (d.avgPrice / maxPriceInChart) * chartHeight} r="4" fill="#3b82f6" className="opacity-0 group-hover:opacity-100 transition-opacity" />
                        <circle cx={x} cy={chartHeight - (d.minPrice / maxPriceInChart) * chartHeight} r="4" fill="#94a3b8" className="opacity-0 group-hover:opacity-100 transition-opacity" />

                        {/* Etiquetas del Eje X */}
                        {i % 2 === 0 && (
                           <text x={x} y={chartHeight + 25} fontSize="11" fill="#64748b" textAnchor="middle" fontWeight="500">W{d.week.split(' ')[1]}</text>
                        )}
                      </g>
                    )
                  })}
               </svg>

               {/* Tooltip Dinámico */}
               {hoveredData && (
                 <div className="absolute top-0 right-0 bg-slate-900 text-white p-4 rounded-xl shadow-xl text-sm pointer-events-none z-10 transform -translate-y-2 border border-slate-700 min-w-[180px]">
                   <p className="font-bold mb-3 border-b border-slate-700 pb-2 text-slate-200">{hoveredData.week} <span className="text-slate-400 font-normal">({hoveredData.month})</span></p>
                   <div className="flex justify-between gap-4 text-emerald-400 mb-1"><span>Máximo:</span> <span className="font-semibold">{hoveredData.maxPrice}€</span></div>
                   <div className="flex justify-between gap-4 text-blue-400 mb-1 font-bold"><span>Medio:</span> <span>{hoveredData.avgPrice}€</span></div>
                   <div className="flex justify-between gap-4 text-slate-300 mb-3"><span>Mínimo:</span> <span className="font-semibold">{hoveredData.minPrice}€</span></div>
                   <div className="pt-2 border-t border-slate-700 text-xs text-slate-400 flex justify-between gap-2">
                     <span>Oferta Activa:</span> <span className="font-medium text-slate-300">{hoveredData.totalCount} aptos</span>
                   </div>
                 </div>
               )}
            </div>
          </div>
        </div>

        {/* Market Insights */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
          <div className="bg-gradient-to-br from-blue-600 to-blue-700 p-8 rounded-3xl shadow-lg shadow-blue-900/20 text-white relative overflow-hidden group">
            <div className="absolute top-0 right-0 w-64 h-64 bg-white/10 rounded-full translate-x-32 -translate-y-32 transition-transform group-hover:scale-110"></div>
            <h3 className="text-xl font-black mb-4 flex items-center gap-2">
              <TrendingUp className="w-6 h-6 text-blue-200" />
              Estrategia Recomendada
            </h3>
            <p className="text-blue-100 text-sm leading-relaxed mb-6">
              Basado en el análisis de {weeklyAggregatedData.length} periodos en {selectedLocation}, recomendamos una tarifa de <span className="text-white font-bold">{Math.round(kpis.avg * 1.05)}€</span> para capturar demanda premium manteniendo alta ocupación.
            </p>
            <div className="flex gap-4">
              <div className="bg-white/10 px-4 py-2 rounded-xl backdrop-blur-sm border border-white/20">
                <span className="block text-[10px] uppercase font-bold text-blue-200">Potencial</span>
                <span className="text-lg font-black">+{Math.round((kpis.max/kpis.avg - 1) * 100)}% ADR</span>
              </div>
              <div className="bg-white/10 px-4 py-2 rounded-xl backdrop-blur-sm border border-white/20">
                <span className="block text-[10px] uppercase font-bold text-blue-200">Confianza</span>
                <span className="text-lg font-black">{kpis.avgCount > 20 ? 'Alta' : 'Media'}</span>
              </div>
            </div>
          </div>

          <div className="bg-white p-8 rounded-3xl shadow-sm border border-slate-100 flex flex-col justify-between">
            <div>
              <h3 className="text-xl font-black text-slate-800 mb-2">Resumen de Inventario</h3>
              <p className="text-slate-400 text-sm">Distribución de la oferta activa en el mercado competitivo.</p>
            </div>
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-bold uppercase tracking-wider">
                  <span className="text-slate-500">Ocupación estimada</span>
                  <span className="text-blue-600">{kpis.occupancy}%</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-500 rounded-full" style={{ width: `${kpis.occupancy}%` }}></div>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex justify-between text-xs font-bold uppercase tracking-wider">
                  <span className="text-slate-500">Presión Competitiva</span>
                  <span className="text-emerald-600">{kpis.pressure}</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full" style={{ width: kpis.pressure === 'Alta' ? '90%' : (kpis.pressure === 'Media' ? '50%' : '20%') }}></div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Tabla Detallada */}
        <div className="bg-white rounded-3xl shadow-sm border border-slate-100 overflow-hidden mb-12">
          <div className="p-8 border-b border-slate-100 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div>
              <h2 className="text-xl font-black text-slate-800 flex items-center gap-2">
                <CalendarDays className="w-6 h-6 text-slate-400" />
                Proyección de Pricing & Inventory
              </h2>
              <p className="text-slate-400 text-sm mt-1">Estrategia detallada por semana para {selectedLocation === 'Todas' ? 'Tenerife' : selectedLocation}</p>
            </div>
            <div className="flex items-center gap-2 text-xs font-bold bg-slate-50 px-3 py-1.5 rounded-lg border border-slate-100 text-slate-500">
              <Clock className="w-3 h-3" /> LOS: {selectedStay} Días
            </div>
          </div>
          
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50 text-slate-400 text-[10px] uppercase tracking-widest border-b border-slate-100">
                  <th className="p-6 font-black">Periodo</th>
                  <th className="p-6 font-black">Mes</th>
                  <th className="p-6 font-black text-right">Mínimo / Noche</th>
                  <th className="p-6 font-black text-right">Referencia Real (Mediana)</th>
                  <th className="p-6 font-black text-right">Premium (Máx / Noche)</th>
                  <th className="p-6 font-black text-right">Inventario Activo</th>
                </tr>
              </thead>
              <tbody>
                {weeklyAggregatedData.map((row, index) => (
                  <tr key={index} className="group border-b border-slate-50 hover:bg-blue-50/30 transition-colors">
                    <td className="p-6">
                      <div className="flex flex-col">
                        <span className="text-sm font-bold text-slate-800">{row.week}</span>
                        <span className="text-[10px] text-slate-400 font-medium">Temporada {index < 12 ? 'Baja' : (index < 35 ? 'Media' : 'Alta')}</span>
                      </div>
                    </td>
                    <td className="p-6">
                      <span className="px-3 py-1 rounded-full bg-slate-100 text-slate-600 text-[10px] font-bold uppercase">{row.month}</span>
                    </td>
                    <td className="p-6 text-sm text-slate-500 text-right font-medium">{row.minPrice}€</td>
                    <td className="p-6 text-right">
                      <div className="flex flex-col items-end">
                        <span className="text-sm font-black text-blue-600 bg-blue-50 px-2 py-1 rounded-lg flex items-center gap-1">
                          {row.avgPrice}€
                          {row.trend === 'up' && <TrendingUp className="w-3 h-3 text-emerald-500" />}
                          {row.trend === 'down' && <TrendingUp className="w-3 h-3 text-rose-500 rotate-180" />}
                        </span>
                        <span className="text-[9px] text-slate-400 mt-1 uppercase tracking-tighter">Referencia ADR</span>
                      </div>
                    </td>
                    <td className="p-6 text-sm text-emerald-600 text-right font-bold">{row.maxPrice}€</td>
                    <td className="p-6 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <span className="text-sm font-bold text-slate-700">{row.totalCount}</span>
                        <div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden hidden sm:block">
                          <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.min(100, (row.totalCount / 200) * 100)}%` }}></div>
                        </div>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

          </>
        )}

      </main>
    </div>
  );
}
