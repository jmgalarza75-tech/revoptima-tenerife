# RevOptima — Inteligencia de Mercado Tenerife

RevOptima es una plataforma de vigilancia competitiva diseñada para el sector del alquiler vacacional en Tenerife. Utiliza una arquitectura **"Zero-Cost"** de alto rendimiento.

## 🚀 Arquitectura
- **Frontend**: React + Vite + Tailwind CSS.
- **Base de Datos**: Híbrida (Estática JSON + Live API).
- **Backend**: Vercel Serverless Functions.
- **Automatización**: GitHub Actions (Daily Scraping).

## 🛠️ Tecnologías
- **MCP (Model Context Protocol)**: Integración profunda con el servidor de Airbnb para extracción de datos reales.
- **Static First**: Los datos se extraen de forma masiva (52 semanas) y se sirven estáticamente para máxima velocidad y coste cero.
- **Inteligencia**: Cálculos dinámicos de ocupación, presión competitiva y ADR Recomendado.

## 📦 Despliegue
1. Sube el código a un repositorio de GitHub.
2. Conecta el repositorio a Vercel.
3. El despliegue es automático.
4. Los datos se actualizarán solos cada madrugada a las 04:00 AM UTC.

## 📂 Estructura
- `/api`: Funciones Serverless para Vercel.
- `/revoptima-frontend`: Código fuente de la interfaz.
- `/scripts`: Scripts de Node.js para la automatización diaria.
- `/.github/workflows`: Configuración de la CI/CD.

---
Desarrollado con ❤️ para Otasa.
