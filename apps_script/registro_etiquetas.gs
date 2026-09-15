/**
 * registro_etiquetas.gs — Registro compartido de lotes de etiquetas (Tablero eCommerce)
 *
 * Guarda cada lote procesado en la pestaña "Registro etiquetas" de la hoja donde
 * vive este script, y lo devuelve al tablero para mostrarlo a todas.
 *
 * INSTALACIÓN (una sola vez):
 *   1. Crea un Google Sheet nuevo (ej. "Tablero eCommerce - Registro").
 *   2. Extensiones → Apps Script → borra lo que haya → pega este archivo → Guardar.
 *   3. Implementar → Nueva implementación → tipo "Aplicación web":
 *        Ejecutar como: Yo · Quién tiene acceso: Cualquier persona → Implementar.
 *   4. Copia la URL que termina en /exec y pégala en index.html en REGISTRO_URL.
 *
 * Endpoints:
 *   GET  ?action=listarLotes           → { ok, registros: [...] }  (últimos 500)
 *   POST { action: "registrarLote", canal, etiquetas, remision, operadora, sin_sku, fecha, id, archivo }
 */

var HOJA = "Registro etiquetas";
var COLS = ["id", "fecha", "canal", "etiquetas", "remision", "operadora", "sin_sku", "archivo"];

function _hoja() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(HOJA);
  if (!sh) {
    sh = ss.insertSheet(HOJA);
    sh.appendRow(COLS);
    sh.setFrozenRows(1);
  }
  return sh;
}

function _json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || "listarLotes";
  if (action !== "listarLotes") return _json({ ok: false, error: "acción desconocida" });
  var sh = _hoja();
  var datos = sh.getDataRange().getValues();
  var out = [];
  for (var i = datos.length - 1; i >= 1 && out.length < 500; i--) {
    var r = datos[i], o = {};
    COLS.forEach(function (c, k) { o[c] = r[k]; });
    if (o.fecha instanceof Date) o.fecha = o.fecha.toISOString();
    out.push(o);
  }
  return _json({ ok: true, registros: out });
}

function doPost(e) {
  try {
    var b = JSON.parse(e.postData.contents || "{}");
    if (b.action !== "registrarLote") return _json({ ok: false, error: "acción desconocida" });
    if (!b.canal || !b.etiquetas) return _json({ ok: false, error: "faltan canal o etiquetas" });
    var sh = _hoja();
    // Evitar duplicados si el tablero reintenta con el mismo id
    if (b.id) {
      var ids = sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 1).getValues().map(function (r) { return String(r[0]); });
      if (ids.indexOf(String(b.id)) !== -1) return _json({ ok: true, duplicado: true });
    }
    sh.appendRow([
      b.id || "", b.fecha ? new Date(b.fecha) : new Date(), String(b.canal).toUpperCase(),
      Number(b.etiquetas) || 0, String(b.remision || "").toUpperCase(), String(b.operadora || ""),
      Number(b.sin_sku) || 0, String(b.archivo || "")
    ]);
    return _json({ ok: true });
  } catch (err) {
    return _json({ ok: false, error: String(err) });
  }
}
