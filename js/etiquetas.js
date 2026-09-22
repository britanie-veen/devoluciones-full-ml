/**
 * etiquetas.js — Motor de etiquetas SHEIN + TikTok para el Tablero eCommerce.
 *
 * Traducción 1:1 del EtiquetasMuuk.exe (Python: app.py, utils.py,
 * etiquetas_shein.py, etiquetas_tiktok.py, odoo_catalog.py) a JavaScript.
 * Corre 100% en el navegador: los archivos no salen de la computadora.
 *
 * Librerías (globales): PDFLib (pdf-lib), pdfjsLib (pdf.js 3.x), XLSX (SheetJS), JSZip.
 *
 * API pública (window.EtiquetasMotor):
 *   cargarCatalogo(skusRaw)                → recibe {sku: display_name} de catalogo.json
 *   detectarCanal(pdfBytes, filename)      → "tiktok" | "shein" | "desconocido"
 *   procesar({pdfBytes, filename, excelBytes, remision, onProgreso})
 *        → {pdfBytes, stats:{total, sin_sku, canal}, nombreArchivo}
 */
(function (root) {
  "use strict";

  // ── Constantes de layout (utils.py — iguales para los 2 canales) ──────────
  const OUT_W = 300.0, OUT_H = 542.0;
  const OFF_X = 28.7,  OFF_Y = 14.0;
  const TARGET_W = 242.7;
  const FONT_SIZE = 7.5;
  const FONT_SIZE_COUNTER = 11.0;

  // TikTok (etiquetas_tiktok.py)
  const TK = { clip: { x0: 11.14, y0: 2.93, x1: 287.13, y1: 416.92 }, sclH: 364.1 };
  TK.bannerY = OFF_Y + TK.sclH + 8;

  // SHEIN Tipo A (iMile)
  const CLIP_A = { x0: 9.94, y0: 4.23, x1: 272.21, y1: 426.0 };
  const CLIP_A_W = 262.27, CLIP_A_H = 421.77;
  const SCALE_A = TARGET_W / CLIP_A_W;
  const SCL_A_H = round2(CLIP_A_H * SCALE_A);
  const BANNER_A = OFF_Y + SCL_A_H + 8;

  // SHEIN Tipo B (IMI-M04) — clip dinámico short/tall
  const CLIP_B_W = 282.96;
  const SCALE_B = TARGET_W / CLIP_B_W;
  const CLIP_B_SHORT = { x0: 0, y0: 0, x1: CLIP_B_W, y1: 370.0 };
  const CLIP_B_TALL  = { x0: 0, y0: 0, x1: CLIP_B_W, y1: 418.5 };
  const SCL_B_SHORT = round2(370.0 * SCALE_B);
  const SCL_B_TALL  = round2(418.5 * SCALE_B);
  const BANNER_B_SHORT = OFF_Y + SCL_B_SHORT + 8;
  const BANNER_B_TALL  = OFF_Y + SCL_B_TALL + 8;

  function round2(n) { return Math.round(n * 100) / 100; }

  // ── Catálogo (odoo_catalog.py) ─────────────────────────────────────────────
  const STOP_WORDS = new Set(["de", "para", "el", "la", "los", "las", "un", "una"]);
  let _raw = {};      // sku → display_name crudo
  let _catalog = {};  // sku → descripción limpia

  function limpiarDesc(nombre) {
    let desc = nombre.replace(/\[.*?\]\s*/g, "").trim();
    const m = desc.match(/\(([^)]+)\)/);
    if (m) {
      const base = desc.slice(0, desc.indexOf("(")).trim();
      const dentro = m[1];
      const palabras = base.split(/\s+/).filter(p => p && !STOP_WORDS.has(p.toLowerCase()));
      return `${palabras.slice(-3).join(" ")} ${dentro}`.slice(0, 30);
    }
    const palabras = desc.split(/\s+/).filter(Boolean);
    while (palabras.length && STOP_WORDS.has(palabras[0].toLowerCase())) palabras.shift();
    return palabras.join(" ").slice(0, 25);
  }

  function cargarCatalogo(skusRaw) {
    _raw = {}; _catalog = {};
    for (const [sku, nombre] of Object.entries(skusRaw || {})) {
      const s = String(sku).trim();
      if (!s) continue;
      _raw[s] = String(nombre).trim();
      _catalog[s] = limpiarDesc(_raw[s]);
    }
    return Object.keys(_catalog).length;
  }

  // Sin fuzzy match: un SKU desconocido muestra el SKU tal cual (nunca la descripción de otra variante)
  function getDesc(sku) {
    if (!Object.keys(_catalog).length) return sku;
    return _catalog[sku] !== undefined ? _catalog[sku] : sku;
  }

  // 🆕 (22-sep) WALMART: descripción COMPLETA del catálogo (qué es + color), sin
  // el recorte agresivo de limpiarDesc. Solo le quita el prefijo "[SKU] " y deja
  // el resto tal cual (ej. "Funda para Asador Circular (Azul Marino)"). Si el SKU
  // no está en el catálogo, muestra el SKU. Se usa solo en las etiquetas Walmart.
  function descCompleta(sku) {
    const raw = _raw[sku];
    if (!raw) return sku;
    return raw.replace(/^\[.*?\]\s*/, "").trim() || sku;
  }

  function limpiarSkuShein(sku) { return sku.replace(/-ok+$/i, "").trim(); }

  // ── Helpers de texto / Excel ───────────────────────────────────────────────
  function normAcento(s) {
    return String(s).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  }
  function findCol(cols, ...subs) {            // utils._find_col
    for (const sub of subs) for (const c of cols) if (c.trim().toLowerCase().includes(sub.toLowerCase())) return c;
    return null;
  }
  function findColAcento(cols, ...terms) {     // etiquetas_shein._find_col_acento
    for (const t of terms) for (const c of cols) if (normAcento(c.trim()).includes(normAcento(t))) return c;
    return null;
  }
  function esNan(v) {
    if (v === null || v === undefined) return true;
    const s = String(v).trim().toLowerCase();
    return s === "" || s === "nan" || s === "none";
  }
  function parseQty(v) {                        // int(row[col_qty]) si no es nan, si no 1
    if (esNan(v)) return 1;
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : 1;
  }
  function normGuia(v) {                        // etiquetas_shein._norm_guia
    if (v === null || v === undefined) return "";
    if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
    const s = String(v).trim();
    if (s.toLowerCase() === "nan") return "";
    const f = Number(s);
    if (s !== "" && Number.isFinite(f) && Number.isInteger(f) && /^\d+(\.0+)?$/.test(s)) return String(f);
    return s;
  }

  function leerLibro(excelBytes) {
    return XLSX.read(new Uint8Array(excelBytes), { type: "array" });
  }
  function hojaARegistros(wb, nombreHoja) {     // equivalente a pd.read_excel(sheet) con header fila 0
    const ws = wb.Sheets[nombreHoja];
    const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });
    if (!filas.length) return { cols: [], rows: [] };
    const cols = filas[0].map(c => (c === null ? "" : String(c).trim()));
    const rows = filas.slice(1).map(r => { const o = {}; cols.forEach((c, i) => { o[c] = r[i] === undefined ? null : r[i]; }); return o; });
    return { cols, rows };
  }

  // ── PDF: texto y dibujos con pdf.js ────────────────────────────────────────
  async function abrirPdfjs(bytes) {
    return pdfjsLib.getDocument({ data: new Uint8Array(bytes).slice(0) }).promise;
  }
  async function textoPagina(doc, i) {          // ~ page.get_text()
    const page = await doc.getPage(i + 1);
    const tc = await page.getTextContent();
    let out = "", lastX = null, lastY = null;
    for (const it of tc.items) {
      if (!("str" in it)) continue;
      const x = it.transform[4], y = it.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) out += "\n";
      else if (lastX !== null && x - lastX > 1 && out && !out.endsWith(" ") && !out.endsWith("\n")) out += " ";
      out += it.str;
      if (it.hasEOL) out += "\n";
      lastX = x + (it.width || 0); lastY = y;
    }
    return out;
  }
  // ~ max(p["rect"][3] for p in page.get_drawings()) — en coordenadas fitz (origen arriba)
  async function maxDibujoY(doc, i) {
    const page = await doc.getPage(i + 1);
    const H = page.view[3] - page.view[1];
    const ops = await page.getOperatorList();
    const O = pdfjsLib.OPS;
    let ctm = [1, 0, 0, 1, 0, 0]; const stack = []; let maxY = 0;
    const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
    const mul = (a, b) => [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3], a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
    const punto = (x, y) => { const [, py] = apply(ctm, x, y); const yf = H - py; if (yf > maxY) maxY = yf; };
    for (let k = 0; k < ops.fnArray.length; k++) {
      const fn = ops.fnArray[k], a = ops.argsArray[k];
      if (fn === O.save) stack.push(ctm);
      else if (fn === O.restore) ctm = stack.pop() || ctm;
      else if (fn === O.transform) ctm = mul(ctm, a);
      else if (fn === O.constructPath) {
        const [pops, pargs] = a; let j = 0;
        for (const p of pops) {
          if (p === O.moveTo || p === O.lineTo) { punto(pargs[j], pargs[j + 1]); j += 2; }
          else if (p === O.curveTo) { punto(pargs[j], pargs[j + 1]); punto(pargs[j + 2], pargs[j + 3]); punto(pargs[j + 4], pargs[j + 5]); j += 6; }
          else if (p === O.curveTo2 || p === O.curveTo3) { punto(pargs[j], pargs[j + 1]); punto(pargs[j + 2], pargs[j + 3]); j += 4; }
          else if (p === O.rectangle) { punto(pargs[j], pargs[j + 1]); punto(pargs[j] + pargs[j + 2], pargs[j + 1] + pargs[j + 3]); j += 4; }
        }
      }
    }
    return maxY;
  }

  // ── Render de una página (utils._render_page) ──────────────────────────────
  function textoSeguro(font, s) {
    try { font.encodeText(s); return s; }
    catch (e) {
      let out = "";
      for (const ch of s) { try { font.encodeText(ch); out += ch; } catch (e2) { out += "?"; } }
      return out;
    }
  }
  async function renderPagina(ctx, srcIdx, clip, sclH, items, counter, bannerY, remision) {
    const { outDoc, srcDoc, font } = ctx;
    const page = outDoc.addPage([OUT_W, OUT_H]);
    const srcPage = srcDoc.getPage(srcIdx);
    const H = srcPage.getHeight();
    // Rect fitz (origen arriba) → bounding box PDF (origen abajo)
    const emb = await outDoc.embedPage(srcPage, { left: clip.x0, bottom: H - clip.y1, right: clip.x1, top: H - clip.y0 });
    page.drawPage(emb, { x: OFF_X, y: OUT_H - (OFF_Y + sclH), width: TARGET_W, height: sclH });

    // Banners de SKU
    items.forEach(([sku, qty], li) => {
      const desc = sku !== "SIN-SKU" ? getDesc(sku) : "Sin descripción";
      const banner = textoSeguro(font, `${sku}  //  ${desc}  //  ${qty} pz`);
      const bw = font.widthOfTextAtSize(banner, FONT_SIZE);
      const yPos = bannerY + FONT_SIZE + li * (FONT_SIZE + 3);
      page.drawText(banner, { x: (OUT_W - bw) / 2, y: OUT_H - yPos, size: FONT_SIZE, font, color: PDFLib.rgb(0, 0, 0) });
    });

    // Contador + remisión centrados en el espacio blanco inferior
    const counterFull = textoSeguro(font, remision ? `${counter}  ·  ${remision}` : counter);
    const lastBannerY = bannerY + FONT_SIZE + (items.length - 1) * (FONT_SIZE + 3);
    const yCounter = (lastBannerY + OUT_H) / 2;
    const cw = font.widthOfTextAtSize(counterFull, FONT_SIZE_COUNTER);
    page.drawText(counterFull, { x: (OUT_W - cw) / 2, y: OUT_H - yCounter, size: FONT_SIZE_COUNTER, font, color: PDFLib.rgb(0, 0, 0) });
  }

  // ── TikTok (etiquetas_tiktok.py) ───────────────────────────────────────────
  function leerMachoteTiktok(excelBytes) {
    const wb = leerLibro(excelBytes);
    let hojas = wb.SheetNames.filter(s => s.toLowerCase().replace(/[ ()]/g, "").includes("orderskulist"));
    if (!hojas.length) hojas = [wb.SheetNames[0]];
    let cols = [], rows = [];
    for (const h of hojas) {
      try { const r = hojaARegistros(wb, h); if (!cols.length) cols = r.cols; rows = rows.concat(r.rows); } catch (e) { /* igual que Python: se ignora la hoja */ }
    }
    const colTracking = findCol(cols, "tracking");
    const colSku = findCol(cols, "seller sku", "seller_sku") || findCol(cols, "sku");
    const colQty = findCol(cols, "quantity", "cantidad", "qty");
    const colRem = findCol(cols, "remisi", "remission");
    if (!colTracking || !colSku || !colQty) throw new Error(`Columnas no encontradas. Disponibles: ${JSON.stringify(cols)}`);

    const lookup = {}, remisiones = {};
    for (const row of rows) {
      const tid = esNan(row[colTracking]) ? "" : String(row[colTracking]).trim();
      const sku = esNan(row[colSku]) ? "nan" : String(row[colSku]).trim();
      const qty = parseQty(row[colQty]);
      if (!tid) continue;
      if (colRem && !(tid in remisiones)) {
        const rv = esNan(row[colRem]) ? "" : String(row[colRem]).trim();
        if (rv) remisiones[tid] = rv.toUpperCase();
      }
      if (!lookup[tid]) lookup[tid] = [];
      const ex = lookup[tid].find(e => e[0] === sku);
      if (ex) ex[1] += qty; else lookup[tid].push([sku, qty]);
    }
    return { lookup, remisiones };
  }

  async function procesarTiktok(ctx, excelBytes, remision) {
    const { lookup, remisiones } = leerMachoteTiktok(excelBytes);
    const n = ctx.pdfjs.numPages, paginas = [];
    for (let i = 0; i < n; i++) {
      ctx.progreso(`Leyendo etiqueta ${i + 1}/${n}…`);
      const txt = await textoPagina(ctx.pdfjs, i);
      const m = txt.match(/(IM\d{14})/);
      const tid = m ? m[1] : "";
      const items = lookup[tid] || [["SIN-SKU", 1]];
      const rem = remisiones[tid] || remision.trim().toUpperCase();
      paginas.push({ idx: i, items, skuSort: items[0][0], tid, remision: rem });
    }
    paginas.sort((a, b) => cmp(a.skuSort, b.skuSort));
    const total = paginas.length;
    const sinSku = paginas.filter(p => p.items[0][0] === "SIN-SKU").map(p => p.tid);
    for (let o = 0; o < total; o++) {
      ctx.progreso(`Generando ${o + 1}/${total}…`);
      const p = paginas[o];
      await renderPagina(ctx, p.idx, TK.clip, TK.sclH, p.items, `${o + 1}/${total}`, TK.bannerY, p.remision || null);
    }
    return { total, sin_sku: sinSku, canal: "TIKTOK" };
  }

  // ── SHEIN (etiquetas_shein.py) ─────────────────────────────────────────────
  function buscarSkuCatalogo(skuBase, color) {
    const colorLower = color.toLowerCase();
    const candidates = Object.entries(_raw).filter(([k]) => k.startsWith(skuBase));
    if (!candidates.length) return skuBase;
    if (candidates.length === 1) return candidates[0][0];
    const colorWords = colorLower.split(/\s+/).filter(w => w.length > 1);
    let best = candidates[0][0], bestScore = 0;
    for (const [sku, desc] of candidates) {
      const dl = desc.toLowerCase();
      let score = colorWords.filter(w => new RegExp(`\\b${escapeRe(w)}\\b`).test(dl)).length;
      if (sku.toLowerCase().includes("-1pz") && !skuBase.toLowerCase().includes("-1pz")) score -= 0.5;
      if (score > bestScore) { bestScore = score; best = sku; }
    }
    return best;
  }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function extraerSkusDesdeDeclaracion(declTxt) {
    let text = declTxt.replace(/\n/g, " ").split(/\s+/).join(" ");
    const idx = text.toUpperCase().indexOf("IDENTIFICACI");
    if (idx === -1) return [];
    text = text.slice(idx);
    const re = /\/((?:MUK|VIN|CER|IPE)-[^\s/]+)\/([^(]+)\([^)]+\)[^0-9]*(\d+)/g;
    const out = []; let m;
    while ((m = re.exec(text)) !== null) {
      const skuBase = limpiarSkuShein(m[1].trim());
      out.push([buscarSkuCatalogo(skuBase, m[2].trim()), parseInt(m[3], 10)]);
    }
    return out;
  }

  function leerMachoteShein(excelBytes) {
    const wb = leerLibro(excelBytes);
    const { cols, rows } = hojaARegistros(wb, wb.SheetNames[0]);
    const colGuia = findColAcento(cols, "numero de guia", "guia", "tracking");
    const colPed  = findColAcento(cols, "numero de pedido", "pedido");
    const colSku  = findColAcento(cols, "sku del vendedor", "sku vendedor", "sku");
    const colQty  = findColAcento(cols, "cantidad", "canntidad", "catidad", "qty", "tidad");
    if (!colSku)  throw new Error(`No se encontro columna SKU. Disponibles: ${JSON.stringify(cols)}`);
    if (!colGuia) throw new Error(`No se encontro columna de guia. Disponibles: ${JSON.stringify(cols)}`);

    const lookup = {};
    const add = (key, sku, qty) => {
      if (!key || key.toLowerCase() === "nan") return;
      if (!lookup[key]) lookup[key] = [];
      const ex = lookup[key].find(e => e[0] === sku);
      if (ex) ex[1] += qty; else lookup[key].push([sku, qty]);
    };
    for (const row of rows) {
      let guia = normGuia(row[colGuia]);
      if (!guia && colPed) {
        const ped = esNan(row[colPed]) ? "nan" : String(row[colPed]).trim();
        if (/^GSH\w+$/.test(ped) || /^\d{14}$/.test(ped)) guia = ped;
      }
      if (!guia) continue;
      const sku = limpiarSkuShein(esNan(row[colSku]) ? "nan" : String(row[colSku]).trim());
      const qty = colQty ? parseQty(row[colQty]) : 1;
      add(guia, sku, qty);
      if (colPed) {
        const ped = esNan(row[colPed]) ? "nan" : String(row[colPed]).trim();
        if (ped.startsWith("GSH") && ped.toLowerCase() !== "nan" && ped !== guia) add(ped, sku, qty);
      }
    }
    return lookup;
  }

  function esPaginaFrontal(txt) {
    if (!txt.trim()) return false;
    const t = txt.toUpperCase();
    if ((t.includes("DECLARACI") && t.includes("CONTENIDO")) || t.includes("SEGUIMIENTO")) return false;
    return true;
  }

  async function procesarShein(ctx, excelBytes, remision) {
    const lookup = leerMachoteShein(excelBytes);
    const n = ctx.pdfjs.numPages;
    const textos = [];
    for (let i = 0; i < n; i++) { ctx.progreso(`Leyendo página ${i + 1}/${n}…`); textos.push(await textoPagina(ctx.pdfjs, i)); }

    const paginas = [];
    let i = 0;
    while (i < n) {
      const txt = textos[i];
      if (!esPaginaFrontal(txt)) { i += 1; continue; }
      const tipoB = txt.includes("IMI-M04");
      let clave = "";
      if (tipoB) {
        let m = txt.match(/(GSH\w+)/); clave = m ? m[1] : "";
        if (!clave) { m = txt.match(/\b(\d{14})\b/); if (m) clave = m[1]; }
        if (!clave) { m = txt.match(/\b([A-Z]{2,4}\d{10,})\b/); if (m) clave = m[1]; }
        if (!clave && i + 1 < n) { m = textos[i + 1].match(/SEGUIMIENTO[\uff1a:\s]+(\S+)/); if (m) clave = m[1]; }
      } else {
        const m = txt.match(/\b(\d{14})\b/); clave = m ? m[1] : "";
      }
      if (!clave) { i += 1; continue; }
      let items = lookup[clave] || [["SIN-SKU", 1]];
      if (items.length && items[0][0].toUpperCase() === "MULTIPLE" && i + 1 < n) {
        const ex = extraerSkusDesdeDeclaracion(textos[i + 1]);
        if (ex.length) items = ex;
      }
      let clipB = null, sclB = null, bannerB = null;
      if (tipoB) {
        const maxY = await maxDibujoY(ctx.pdfjs, i);
        if (maxY > 380) { clipB = CLIP_B_TALL; sclB = SCL_B_TALL; bannerB = BANNER_B_TALL; }
        else { clipB = CLIP_B_SHORT; sclB = SCL_B_SHORT; bannerB = BANNER_B_SHORT; }
      }
      paginas.push({ idx: i, tipoB, clave, items, skuSort: items[0][0], clipB, sclB, bannerB });
      // Saltar 2 solo si la siguiente página es declaración; si no, saltar 1
      if (i + 1 < n && !esPaginaFrontal(textos[i + 1])) i += 2; else i += 1;
    }
    paginas.sort((a, b) => cmp(a.skuSort, b.skuSort));
    const total = paginas.length;
    const sinSku = paginas.filter(p => p.items[0][0] === "SIN-SKU").map(p => p.clave);
    const rem = remision.trim().toUpperCase() || null;
    for (let o = 0; o < total; o++) {
      ctx.progreso(`Generando ${o + 1}/${total}…`);
      const p = paginas[o];
      if (p.tipoB) await renderPagina(ctx, p.idx, p.clipB, p.sclB, p.items, `${o + 1}/${total}`, p.bannerB, rem);
      else         await renderPagina(ctx, p.idx, CLIP_A, SCL_A_H, p.items, `${o + 1}/${total}`, BANNER_A, rem);
    }
    return { total, sin_sku: sinSku, canal: "SHEIN" };
  }

  // Orden "alfabético" igual que Python (comparación de strings por código de carácter)
  function cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

  // ════════════════════════════════════════════════════════════════════════════
  // 🆕 (22-sep) WALMART — etiquetas FedEx.
  // A diferencia de SHEIN/TikTok, la etiqueta de Walmart es una IMAGEN (sin
  // texto): no se puede leer el tracking del texto. Por eso se renderiza cada
  // página a un <canvas> y se LEE su código de barras (Code128/PDF417) con ZXing;
  // los últimos 12 dígitos son el "Número De Rastreo" del machote. NO se recorta
  // la etiqueta: se deja completa y se le agrega abajo una franja con
  // SKU + descripción (catálogo) + cantidad + conteo + remisión, ordenado por SKU.
  // ════════════════════════════════════════════════════════════════════════════
  function ultimos12(v) { const d = String(v == null ? "" : v).replace(/\D/g, ""); return d.length >= 12 ? d.slice(-12) : d; }

  // ¿El Excel es un machote de Walmart? (tiene columna "...rastreo..." + "sku").
  // A propósito pide "rastreo" (no "tracking") para no confundirlo con TikTok.
  function esMachoteWalmart(excelBytes) {
    try {
      const wb = leerLibro(excelBytes);
      for (const name of wb.SheetNames) {
        const { cols } = hojaARegistros(wb, name);
        if (findCol(cols, "rastreo") && findCol(cols, "sku")) return true;
      }
    } catch (e) { /* no es Walmart */ }
    return false;
  }

  function hojaMachoteWalmart_(wb) {
    for (const name of wb.SheetNames) {
      const { cols } = hojaARegistros(wb, name);
      if (findCol(cols, "rastreo", "tracking", "guia") && findCol(cols, "sku")) return name;
    }
    return wb.SheetNames[0];
  }

  // lookup: tracking(12) → [[sku, qty], …] · remisiones: tracking(12) → remisión
  function leerMachoteWalmart(excelBytes) {
    const wb = leerLibro(excelBytes);
    const { cols, rows } = hojaARegistros(wb, hojaMachoteWalmart_(wb));
    const colTrk = findCol(cols, "numero de rastreo", "rastreo", "tracking", "guia");
    const colSku = findCol(cols, "sku");
    const colQty = findCol(cols, "cantidad", "quantity", "qty");
    const colRem = findCol(cols, "remisi", "remission");
    if (!colTrk || !colSku) throw new Error(`Machote de Walmart: no encontré columnas de rastreo/SKU. Disponibles: ${JSON.stringify(cols)}`);
    const lookup = {}, remisiones = {};
    for (const row of rows) {
      const trk = ultimos12(row[colTrk]);
      if (trk.length < 12) continue;
      const sku = esNan(row[colSku]) ? "nan" : String(row[colSku]).trim();
      const qty = colQty ? parseQty(row[colQty]) : 1;
      if (colRem && !(trk in remisiones)) { const rv = esNan(row[colRem]) ? "" : String(row[colRem]).trim(); if (rv) remisiones[trk] = rv.toUpperCase(); }
      if (!lookup[trk]) lookup[trk] = [];
      const ex = lookup[trk].find(e => e[0] === sku);
      if (ex) ex[1] += qty; else lookup[trk].push([sku, qty]);
    }
    return { lookup, remisiones, validos: new Set(Object.keys(lookup)) };
  }

  // Render de una página del PDF a un <canvas> (para leer el código de barras).
  async function paginaACanvas(doc, i, scale) {
    const page = await doc.getPage(i + 1);
    const vp = page.getViewport({ scale: scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(vp.width); canvas.height = Math.ceil(vp.height);
    const c2d = canvas.getContext("2d", { willReadFrequently: true });
    await page.render({ canvasContext: c2d, viewport: vp }).promise;
    return canvas;
  }

  // Lee los códigos de barras del canvas y devuelve el tracking (12 díg) que EXISTA
  // en el machote. Si ninguno casa, devuelve el primer 12-díg encontrado (para
  // reportar) o "".
  // Decodifica UN código de barras de un canvas (o null si no hay). Usa
  // MultiFormatReader (Code128 + PDF417). No depende de clases de "multi".
  function _decodeUno(canvas, hints, reader) {
    let src;
    if (ZXing.HTMLCanvasElementLuminanceSource) {
      src = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
    } else {
      const img = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height);
      const lum = new Uint8ClampedArray(canvas.width * canvas.height);
      for (let i = 0, j = 0; i < img.data.length; i += 4, j++) lum[j] = (img.data[i] * 0.299 + img.data[i + 1] * 0.587 + img.data[i + 2] * 0.114) | 0;
      src = new ZXing.RGBLuminanceSource(lum, canvas.width, canvas.height);
    }
    const bitmap = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(src));
    try { const r = reader.decode(bitmap, hints); return r ? String(r.getText()) : ""; }
    catch (e) { return ""; }
    finally { try { reader.reset(); } catch (e) {} }
  }

  // Devuelve el tracking (12 díg del machote) leído de la etiqueta. La etiqueta
  // trae VARIOS códigos; como ZXing.decode lee solo uno, se decodifica la imagen
  // completa Y en bandas horizontales, y se busca el tracking como SUBCADENA de
  // los dígitos leídos (funciona con el Code128 de 34 díg y con el PDF417, que
  // llevan el tracking adentro). Si nada casa, devuelve "" (→ SIN-SKU).
  function leerTrackingBarcode(canvas, validos) {
    if (typeof ZXing === "undefined" || !ZXing.MultiFormatReader) {
      throw new Error("No cargó el lector de código de barras. Recarga la página e intenta de nuevo.");
    }
    const hints = new Map();
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.PDF_417]);
    const reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);
    const trks = Array.from(validos);
    const casa = (txt) => { const d = String(txt).replace(/\D/g, ""); for (const trk of trks) if (d.indexOf(trk) !== -1) return trk; return ""; };

    // 1) imagen completa
    let m = casa(_decodeUno(canvas, hints, reader));
    if (m) return m;

    // 2) bandas horizontales solapadas (cada Code128 por separado)
    const W = canvas.width, H = canvas.height, N = 10;
    const step = Math.max(1, Math.floor(H / N)), bandH = Math.min(H, step * 2);
    let fallback = "";
    for (let b = 0; b < N; b++) {
      const y = Math.min(b * step, H - 1), hh = Math.min(bandH, H - y);
      if (hh < 24) continue;
      const c = document.createElement("canvas"); c.width = W; c.height = hh;
      c.getContext("2d", { willReadFrequently: true }).drawImage(canvas, 0, y, W, hh, 0, 0, W, hh);
      const txt = _decodeUno(c, hints, reader);
      if (!txt) continue;
      m = casa(txt); if (m) return m;
      const d = txt.replace(/\D/g, ""); if (!fallback && d.length >= 12) fallback = d.slice(-12);
    }
    return fallback && validos.has(fallback) ? fallback : "";
  }

  // Render de una etiqueta Walmart: NO se recorta. Etiqueta completa arriba +
  // franja blanca abajo con el banner (una línea por SKU) + contador y remisión.
  // La letra se ajusta sola para que quepa.
  async function renderPaginaWalmart(ctx, srcIdx, items, counter, remision) {
    const { outDoc, srcDoc, font } = ctx;
    const srcPage = srcDoc.getPage(srcIdx);
    const w = srcPage.getWidth(), h = srcPage.getHeight();
    const lineas = items.map(function (it) {
      const sku = it[0];
      const desc = sku === "SIN-SKU" ? "Sin descripción" : descCompleta(sku);
      return `${sku}  //  ${desc}  //  ${it[1]} pz`;
    });
    const contLinea = remision ? `${counter}   ·   ${remision}` : counter;
    const todas = lineas.concat([contLinea]);
    const usable = w - 16;
    let size = 9;
    while (size > 6 && todas.some(function (t) { return font.widthOfTextAtSize(textoSeguro(font, t), size) > usable; })) size -= 0.5;
    const gap = 4;
    const STRIP = 12 + todas.length * (size + gap);
    const page = outDoc.addPage([w, h + STRIP]);
    const emb = await outDoc.embedPage(srcPage);
    page.drawPage(emb, { x: 0, y: STRIP, width: w, height: h });
    page.drawLine({ start: { x: 0, y: STRIP }, end: { x: w, y: STRIP }, thickness: 1, color: PDFLib.rgb(0, 0, 0) });
    let y = STRIP - 6 - size;
    for (const t of todas) {
      const s = textoSeguro(font, t);
      const tw = font.widthOfTextAtSize(s, size);
      page.drawText(s, { x: (w - tw) / 2, y: y, size: size, font: font, color: PDFLib.rgb(0, 0, 0) });
      y -= (size + gap);
    }
  }

  async function procesarWalmart(ctx, excelBytes, remision) {
    const { lookup, remisiones, validos } = leerMachoteWalmart(excelBytes);
    const n = ctx.pdfjs.numPages, paginas = [];
    for (let i = 0; i < n; i++) {
      ctx.progreso(`Leyendo etiqueta ${i + 1}/${n}…`);
      const canvas = await paginaACanvas(ctx.pdfjs, i, 4);
      const trk = leerTrackingBarcode(canvas, validos);
      const items = (trk && lookup[trk]) ? lookup[trk] : [["SIN-SKU", 1]];
      const rem = (trk && remisiones[trk]) || (remision || "").trim().toUpperCase();
      paginas.push({ idx: i, items: items, skuSort: items[0][0], trk: trk, remision: rem });
    }
    paginas.sort(function (a, b) { return cmp(a.skuSort, b.skuSort); });
    const total = paginas.length;
    const sinSku = paginas.filter(function (p) { return p.items[0][0] === "SIN-SKU"; }).map(function (p) { return p.trk || ("pág " + (p.idx + 1)); });
    for (let o = 0; o < total; o++) {
      ctx.progreso(`Generando ${o + 1}/${total}…`);
      const p = paginas[o];
      await renderPaginaWalmart(ctx, p.idx, p.items, `${o + 1}/${total}`, p.remision || null);
    }
    return { total: total, sin_sku: sinSku, canal: "WALMART" };
  }

  // ── Detección de canal (app.py) ────────────────────────────────────────────
  async function detectarCanal(pdfBytes, filename = "") {
    try {
      const doc = await abrirPdfjs(pdfBytes);
      let texto = "";
      for (let i = 0; i < Math.min(3, doc.numPages); i++) texto += await textoPagina(doc, i);
      await doc.destroy();
      const t = texto.toUpperCase();
      if (t.includes("TIKTOK") || t.includes("SITIOWEB")) return "tiktok";
      if (t.includes("SHEIN") || t.includes("IMILE.COM") || t.includes("IMILE")) return "shein";
    } catch (e) { /* cae al nombre de archivo */ }
    const fn = filename.toUpperCase();
    if (fn.includes("TIKTOK") || fn.includes("TIKT")) return "tiktok";
    if (fn.includes("SHEIN")) return "shein";
    return "desconocido";
  }

  // ── ZIP con varios PDFs → un solo PDF combinado (app.extraer_y_combinar_zip) ─
  async function combinarZip(zipBytes) {
    const zip = await JSZip.loadAsync(zipBytes);
    const nombres = Object.keys(zip.files).filter(n => n.toLowerCase().endsWith(".pdf") && !zip.files[n].dir).sort();
    if (!nombres.length) throw new Error("El ZIP no contiene ningún PDF.");
    const base = await PDFLib.PDFDocument.create();
    for (const nm of nombres) {
      const bytes = await zip.files[nm].async("uint8array");
      const d = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      const pages = await base.copyPages(d, d.getPageIndices());
      pages.forEach(p => base.addPage(p));
    }
    return base.save();
  }

  // ── Punto de entrada (app.procesar) ────────────────────────────────────────
  async function procesar({ pdfBytes, filename = "", excelBytes, remision = "", onProgreso }) {
    const progreso = typeof onProgreso === "function" ? onProgreso : () => {};
    if (!pdfBytes || !excelBytes) throw new Error("Debes subir el PDF de etiquetas y el Excel.");

    const u8 = new Uint8Array(pdfBytes);
    const esZip = filename.toLowerCase().endsWith(".zip") || (u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04);
    let bytes = pdfBytes;
    if (esZip) {
      progreso("Combinando PDFs del ZIP…");
      bytes = await combinarZip(pdfBytes);
    }

    progreso("Detectando canal…");
    let canal = await detectarCanal(bytes, filename);
    // 🆕 (22-sep): la etiqueta de Walmart es una IMAGEN (sin texto), así que
    // detectarCanal no la reconoce por texto. Si el machote es de Walmart
    // (columna "…rastreo…"), entonces es Walmart.
    if (canal === "desconocido" && esMachoteWalmart(excelBytes)) canal = "walmart";
    if (canal === "desconocido") throw new Error("No se pudo detectar el canal. Verifica que el PDF/machote sea de SHEIN, TikTok o Walmart.");

    const pdfjs = await abrirPdfjs(bytes);
    const srcDoc = await PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true });
    const outDoc = await PDFLib.PDFDocument.create();
    const font = await outDoc.embedFont(PDFLib.StandardFonts.Helvetica);
    const ctx = { pdfjs, srcDoc, outDoc, font, progreso };

    let stats;
    try {
      stats = canal === "shein"   ? await procesarShein(ctx, excelBytes, remision)
            : canal === "walmart" ? await procesarWalmart(ctx, excelBytes, remision)
            :                       await procesarTiktok(ctx, excelBytes, remision);
    } finally {
      await pdfjs.destroy();
    }
    progreso("Guardando PDF…");
    const out = await outDoc.save();
    const hoy = new Date();
    const fecha = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, "0")}-${String(hoy.getDate()).padStart(2, "0")}`;
    return { pdfBytes: out, stats, nombreArchivo: `${stats.canal}_${fecha}.pdf` };
  }

  root.EtiquetasMotor = { cargarCatalogo, getDesc, limpiarDesc, limpiarSkuShein, detectarCanal, procesar,
                          _interno: { leerMachoteTiktok, leerMachoteShein, textoPagina, maxDibujoY, abrirPdfjs } };
})(typeof window !== "undefined" ? window : globalThis);
