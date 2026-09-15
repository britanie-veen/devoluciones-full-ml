# Tablero eCommerce — CERO//CERO

Página única para el equipo de eCommerce: **https://britanie-veen.github.io/devoluciones-full-ml/**

| Sección | Estado | Cómo funciona |
|---|---|---|
| **Devoluciones Mercado Libre** | En uso | Lee el motor en Apps Script (`MOTOR_URL`) y registra remisiones vía `BRIDGE_URL`. |
| **Etiquetas SHEIN & TikTok** | En uso | Procesa las etiquetas **en el navegador** (`js/etiquetas.js`): PDF + machote → PDF listo para imprimir. Lleva un registro de lotes. |
| **Devoluciones Amazon** | Reservada | Se construirá igual que la de Mercado Libre. |

## Etiquetas SHEIN & TikTok

Traducción 1:1 de `EtiquetasMuuk.exe` (Python) a JavaScript. Nada se instala: los archivos se
procesan en la pestaña del navegador y no salen de la computadora.

- `js/etiquetas.js` — motor: detección de canal, SHEIN Tipo A / Tipo B / MULTIPLE / sufijo `-ok`,
  TikTok multi-hoja con remisión por Tracking ID, ZIP con varios PDFs, orden por SKU, banner
  `SKU // descripción // pz`, contador `N/total · REMISIÓN`.
- Librerías (cdnjs): pdf.js 3.11 (leer texto), pdf-lib 1.17 (armar el PDF), SheetJS 0.18 (Excel), JSZip 3.10.
- `catalogo.json` — catálogo de SKUs de Odoo. Lo regenera **GitHub Actions cada hora**
  (`.github/workflows/catalogo.yml` → `scripts/sync_catalogo.py`). Un SKU nuevo en Odoo aparece en
  las etiquetas máximo una hora después, o al instante con *Actions → Sincronizar catálogo Odoo → Run workflow*.
- `apps_script/registro_etiquetas.gs` — registro compartido de lotes (canal, etiquetas, remisión,
  operadora, hora). Mientras no esté instalado, el registro se guarda solo en cada computadora.

### Secrets del repo (Settings → Secrets and variables → Actions)
`ODOO_URL`, `ODOO_DB`, `ODOO_USER`, `ODOO_API_KEY` — solo los usa el Action; nunca van en el código.

## Devoluciones Mercado Libre
- `scripts/actualizar_datos.py` y `scripts/diagnostico_devoluciones.py` — consultas a la API de ML
  (credenciales por variables de entorno). Hoy la página lee el motor en Apps Script, no `data.json`.
