#!/usr/bin/env python3
"""
Devoluciones — actualizador de datos (FULL y Colecta, ambos, siempre etiquetados).

SOLO LECTURA. Nunca hace POST/PUT contra la API de Mercado Libre para
responder reclamos, refrescar devoluciones ni ninguna acción de escritura
salvo el refresh del propio access_token (que es necesario para poder leer).
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

API_BASE = "https://api.mercadolibre.com"
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data.json")


def env(name):
    valor = os.environ.get(name)
    if not valor:
        print(f"Falta la variable de entorno {name}", file=sys.stderr)
        sys.exit(1)
    return valor


def refrescar_token():
    datos = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": env("ML_CLIENT_ID"),
        "client_secret": env("ML_CLIENT_SECRET"),
        "refresh_token": env("ML_REFRESH_TOKEN"),
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{API_BASE}/oauth/token", data=datos,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8"))


def ml_get(path, token, intentos_max=4):
    intentos = 0
    while intentos < intentos_max:
        req = urllib.request.Request(
            f"{API_BASE}{path}", headers={"Authorization": f"Bearer {token}"}
        )
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                time.sleep(1.0 * (intentos + 1))
                intentos += 1
                continue
            return {"_error": e.code, "_body": e.read().decode("utf-8")}
    return {"_error": 429, "_body": "rate limit persistente"}


def procesar_claim(claim, token, reclamos, en_camino, llegaron):
    shipping_id = None
    order_id = None
    if claim.get("resource") == "shipment":
        shipping_id = claim.get("resource_id")
    elif claim.get("resource") == "order":
        order_id = claim.get("resource_id")
        order = ml_get(f"/orders/{order_id}", token)
        if "_error" not in order:
            shipping_id = (order.get("shipping") or {}).get("id")

    canal = "Desconocido"
    if shipping_id:
        time.sleep(0.3)
        shipment = ml_get(f"/shipments/{shipping_id}", token)
        if "_error" not in shipment:
            canal = "FULL" if shipment.get("logistic_type") == "fulfillment" else "Colecta"

    resumen = {
        "claim_id": claim.get("id"),
        "order_id": order_id,
        "reason_id": claim.get("reason_id"),
        "type": claim.get("type"),
        "stage": claim.get("stage"),
        "canal": canal,
    }

    seller = next((p for p in claim.get("players", []) if p.get("type") == "seller"), None)
    accion_urgente = None
    if seller:
        for a in seller.get("available_actions", []):
            if a.get("due_date") and (accion_urgente is None or a["due_date"] < accion_urgente["due_date"]):
                accion_urgente = a

    if accion_urgente:
        item = dict(resumen, accion=accion_urgente["action"], vence=accion_urgente["due_date"])
        hoy = datetime.now(timezone.utc).date().isoformat()
        item["urgente_hoy"] = accion_urgente["due_date"][:10] <= hoy
        reclamos.append(item)

    time.sleep(0.3)
    ret = ml_get(f"/post-purchase/v2/claims/{claim.get('id')}/returns", token)
    if "_error" in ret:
        return

    shipping_info = ret.get("shipping") or {}
    seller_review = ret.get("seller_review") or {}
    item_dev = dict(
        resumen,
        status=ret.get("status"),
        shipping_status=shipping_info.get("status"),
        seller_review=seller_review.get("status"),
        tracking_number=shipping_info.get("tracking_number"),
    )

    if ret.get("status") in ("cancelled", "failed", "expired", "closed"):
        return

    if shipping_info.get("status") == "delivered":
        llegaron.append(item_dev)
    else:
        en_camino.append(item_dev)


def construir_dashboard():
    tokens = refrescar_token()
    if "access_token" not in tokens:
        print("No se pudo refrescar el token:", tokens, file=sys.stderr)
        sys.exit(1)
    token = tokens["access_token"]

    me = ml_get("/users/me", token)
    user_id = me.get("id")

    reclamos = []
    en_camino = []
    llegaron = []

    offset = 0
    limit = 20
    total = None
    tope_seguridad = 300

    while (total is None or offset < total) and offset < tope_seguridad:
        pagina = ml_get(
            f"/post-purchase/v1/claims/search?player_role=respondent&player_user_id={user_id}"
            f"&status=opened&limit={limit}&offset={offset}&sort=date_created:desc",
            token,
        )
        if "_error" in pagina:
            print("Error buscando reclamos:", pagina, file=sys.stderr)
            break

        total = (pagina.get("paging") or {}).get("total", 0)
        claims = pagina.get("data", [])
        if not claims:
            break

        for c in claims:
            procesar_claim(c, token, reclamos, en_camino, llegaron)

        offset += limit

    return {
        "generado": datetime.now(timezone.utc).isoformat(),
        "reclamos": reclamos,
        "en_camino": en_camino,
        "llegaron": llegaron,
    }


if __name__ == "__main__":
    data = construir_dashboard()
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"data.json actualizado: {len(data['reclamos'])} reclamos, "
          f"{len(data['en_camino'])} en camino, {len(data['llegaron'])} llegaron.")
