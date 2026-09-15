"""
sync_catalogo.py — Sincroniza el catálogo de SKUs de Odoo a catalogo.json.

Lo ejecuta GitHub Actions cada hora (o a mano desde la pestaña Actions).
EtiquetasMuuk.exe descarga el JSON resultante al arrancar, así el catálogo
se actualiza solo sin exportar Excel ni recompilar el .exe.

Credenciales: variables de entorno ODOO_URL, ODOO_DB, ODOO_USER, ODOO_API_KEY
(en GitHub viven como Secrets; en local se pueden exportar en la terminal).

Formato de salida (catalogo.json):
{
  "generado": "2026-09-15T10:00:00",
  "total": 513,
  "skus": { "CER-CAMNEG": "[CER-CAMNEG] Cama para Mecánico", ... }
}
El valor es el display_name crudo de Odoo (igual a "Nombre en pantalla" del
export a Excel). La limpieza de la descripción la hace el .exe.
"""
import json
import os
import ssl
import sys
import xmlrpc.client
from datetime import datetime
from zoneinfo import ZoneInfo

SALIDA = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "catalogo.json")  # raíz del repo


def _env(nombre):
    val = os.environ.get(nombre, "").strip()
    if not val:
        sys.exit(f"Falta la variable de entorno {nombre}")
    return val


def leer_odoo():
    url, db, user, key = _env("ODOO_URL"), _env("ODOO_DB"), _env("ODOO_USER"), _env("ODOO_API_KEY")
    ctx = ssl.create_default_context()
    transport = xmlrpc.client.SafeTransport(context=ctx)

    common = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common", transport=transport)
    uid = common.authenticate(db, user, key, {})
    if not uid:
        sys.exit("Autenticación Odoo fallida. Verifica credenciales.")

    models = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object", transport=transport)
    rows = models.execute_kw(
        db, uid, key,
        "product.product", "search_read",
        # Solo productos físicos activos con SKU (excluye servicios como COMM, FOOD, GIFT)
        [[["default_code", "!=", False], ["is_storable", "=", True]]],
        {"fields": ["default_code", "display_name"], "order": "default_code"},
    )
    skus = {}
    for r in rows:
        sku = str(r["default_code"]).strip()
        if sku:
            skus[sku] = str(r["display_name"]).strip()
    return skus


def main():
    skus = leer_odoo()
    if len(skus) < 100:
        # Un catálogo casi vacío casi seguro es un error de Odoo/red: no lo publicamos.
        sys.exit(f"Solo se leyeron {len(skus)} SKUs; se conserva el catálogo anterior.")

    anterior = {}
    if os.path.exists(SALIDA):
        with open(SALIDA, encoding="utf-8") as f:
            anterior = json.load(f).get("skus", {})

    if anterior == skus:
        print(f"Sin cambios: {len(skus)} SKUs.")
        return

    nuevos    = sorted(set(skus) - set(anterior))
    quitados  = sorted(set(anterior) - set(skus))
    cambiados = sorted(k for k in skus if k in anterior and anterior[k] != skus[k])

    with open(SALIDA, "w", encoding="utf-8") as f:
        json.dump(
            {"generado": datetime.now(ZoneInfo("America/Mexico_City")).replace(microsecond=0, tzinfo=None).isoformat(),
             "total": len(skus), "skus": skus},
            f, ensure_ascii=False, indent=1,
        )
    print(f"Catálogo actualizado: {len(skus)} SKUs "
          f"(+{len(nuevos)} nuevos, -{len(quitados)} quitados, {len(cambiados)} renombrados)")
    for s in nuevos[:20]:
        print(f"  + {s}")


if __name__ == "__main__":
    main()
