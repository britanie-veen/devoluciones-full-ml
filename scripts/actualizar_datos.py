#!/usr/bin/env python3
"""
Devoluciones — actualizador de datos (FULL y Colecta, ambos, siempre etiquetados).

SOLO LECTURA. Nunca hace POST/PUT contra la API de Mercado Libre para
responder reclamos, refrescar devoluciones ni ninguna acción de escritura
salvo el refresh del propio access_token (que es necesario para poder leer).

Nota: este script ya NO consulta el estado de envío de las devoluciones
(bloques "en camino" / "ya llegaron"). Para FULL, que un envío no esté
"delivered" no significa que vaya rumbo al almacén propio — normalmente
se queda en el centro de Mercado Libre y solo a veces termina llegando.
Mostrar eso generaba ruido que nadie podía accionar. Ahora solo se
reportan los reclamos con una acción pendiente del vendedor, divididos
en "urgentes" (vencen hoy o ya vencieron) y "proximas_por_atender"
(tienen fecha límite pero todavía no es hoy) — igual que se ven en la
pestaña Posventa > Devoluciones de Mercado Libre.
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


def procesar_claim(claim, token, urgentes, proximas_por_atender):
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

    if not accion_urgente:
        return

    item = dict(resumen, accion=accion_urgente["action"], vence=accion_urgente["due_date"])
    hoy = datetime.now(timezone.utc).date().isoformat()
    if accion_urgente["due_date"][:10] <= hoy:
        urgentes.append(item)
    else:
        proximas_por_atender.append(item)


def construir_dashboard():
    tokens = refrescar_token()
    if "access_token" not in tokens:
        print("No se pudo refrescar el token:", tokens, file=sys.stderr)
        sys.exit(1)
    token = tokens["access_token"]

    me = ml_get("/users/me", token)
    user_id = me.get("id")

    urgentes = []
    proximas_por_atender = []

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
            procesar_claim(c, token, urgentes, proximas_por_atender)

        offset += limit

    return {
        "generado": datetime.now(timezone.utc).isoformat(),
        "urgentes": urgentes,
        "proximas_por_atender": proximas_por_atender,
    }


if __name__ == "__main__":
    data = construir_dashboard()
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"data.json actualizado: {len(data['urgentes'])} urgentes, "
          f"{len(data['proximas_por_atender'])} proximas por atender.")
