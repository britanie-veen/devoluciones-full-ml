#!/usr/bin/env python3
"""
Devoluciones — actualizador de datos.

SOLO LECTURA. Nunca hace POST/PUT contra la API de Mercado Libre para
responder reclamos, refrescar devoluciones ni ninguna accion de escritura,
salvo el refresh del propio access_token (necesario para poder leer).

El tablero tiene dos partes:

1. Reclamos — reclamos y mediaciones con una accion pendiente del
   vendedor con fecha limite, divididos en "urgentes" (vencen hoy o ya
   vencieron) y "proximas_por_atender" (tienen fecha limite pero
   todavia no es hoy). Igual que la pestaña Posventa > Reclamos y
   mediaciones de Mercado Libre.

2. Devoluciones por revisar — devoluciones que YA estan cerradas para
   la API, pero que de verdad necesitan que alguien las revise. Se
   identifican con 3 condiciones confirmadas con datos reales:
     a) el envio de regreso ya se entrego (status "delivered")
     b) todavia no se ha revisado (intermediate_check es false)
     c) llego al almacen propio, no al de Full (destino "seller_address",
        no "warehouse" — las que regresan a Full no nos pertenecen y se
        excluyen solas con este filtro)
   Solo se revisan reclamos cerrados de los ultimos 60 dias, para no
   tener que repasar el historial completo cada 10 minutos.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

API_BASE = "https://api.mercadolibre.com"
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data.json")
DIAS_ATRAS_DEVOLUCIONES = 60


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


def resolver_canal(order_id, token):
    """FULL si el envio original de la venta es fulfillment, si no Colecta."""
    if not order_id:
        return "Desconocido"
    order = ml_get(f"/orders/{order_id}", token)
    if "_error" in order:
        return "Desconocido"
    shipping_id = (order.get("shipping") or {}).get("id")
    if not shipping_id:
        return "Desconocido"
    time.sleep(0.3)
    shipment = ml_get(f"/shipments/{shipping_id}", token)
    if "_error" in shipment:
        return "Desconocido"
    return "FULL" if shipment.get("logistic_type") == "fulfillment" else "Colecta"


# --------------------------------------------------------------------------
# Parte 1: Reclamos con fecha limite (abiertos)
# --------------------------------------------------------------------------

def procesar_reclamo_abierto(claim, token, urgentes, proximas_por_atender):
    seller = next((p for p in claim.get("players", []) if p.get("type") == "seller"), None)
    accion_urgente = None
    if seller:
        for a in seller.get("available_actions", []):
            if a.get("due_date") and (accion_urgente is None or a["due_date"] < accion_urgente["due_date"]):
                accion_urgente = a

    if not accion_urgente:
        return

    order_id = claim.get("resource_id") if claim.get("resource") == "order" else None
    canal = resolver_canal(order_id, token)

    item = {
        "claim_id": claim.get("id"),
        "order_id": order_id,
        "reason_id": claim.get("reason_id"),
        "type": claim.get("type"),
        "stage": claim.get("stage"),
        "canal": canal,
        "accion": accion_urgente["action"],
        "vence": accion_urgente["due_date"],
    }
    hoy = datetime.now(timezone.utc).date().isoformat()
    if accion_urgente["due_date"][:10] <= hoy:
        urgentes.append(item)
    else:
        proximas_por_atender.append(item)


def buscar_reclamos_abiertos(token, user_id, urgentes, proximas_por_atender):
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
            print("Error buscando reclamos abiertos:", pagina, file=sys.stderr)
            break

        total = (pagina.get("paging") or {}).get("total", 0)
        claims = pagina.get("data", [])
        if not claims:
            break

        for c in claims:
            procesar_reclamo_abierto(c, token, urgentes, proximas_por_atender)

        offset += limit


# --------------------------------------------------------------------------
# Parte 2: Devoluciones cerradas que de verdad necesitan revision
# --------------------------------------------------------------------------

def fecha_es_reciente(claim, limite):
    crudo = claim.get("date_created")
    if not crudo:
        return True  # si no sabemos la fecha, mejor no perdernosla
    try:
        dt = datetime.fromisoformat(crudo.replace("Z", "+00:00"))
        return dt >= limite
    except ValueError:
        return True


def procesar_devolucion_cerrada(claim, token, devoluciones_por_revisar):
    claim_id = claim.get("id")
    time.sleep(0.3)
    ret = ml_get(f"/post-purchase/v2/claims/{claim_id}/returns", token)
    if "_error" in ret:
        return

    shipments = ret.get("shipments") or []
    envio = shipments[0] if shipments else {}
    destino = (envio.get("destination") or {}).get("name")

    ya_llego = ret.get("status") == "delivered" and envio.get("status") == "delivered"
    sin_revisar = ret.get("intermediate_check") is False
    llego_a_nuestro_almacen = destino == "seller_address"

    if not (ya_llego and sin_revisar and llego_a_nuestro_almacen):
        return  # no cumple las 3 condiciones -> no nos toca revisarla (o es de Full)

    order_id = ret.get("resource_id") if ret.get("resource_type") == "order" else None
    canal = resolver_canal(order_id, token)

    devoluciones_por_revisar.append({
        "claim_id": claim_id,
        "order_id": order_id,
        "reason_id": claim.get("reason_id"),
        "type": claim.get("type"),
        "canal": canal,
        "tracking_number": envio.get("tracking_number"),
        "status_money": ret.get("status_money"),
        "date_closed": ret.get("date_closed"),
    })


def buscar_devoluciones_cerradas(token, user_id, devoluciones_por_revisar):
    limite_fecha = datetime.now(timezone.utc) - timedelta(days=DIAS_ATRAS_DEVOLUCIONES)
    offset = 0
    limit = 20
    total = None
    tope_seguridad = 400

    while (total is None or offset < total) and offset < tope_seguridad:
        pagina = ml_get(
            f"/post-purchase/v1/claims/search?player_role=respondent&player_user_id={user_id}"
            f"&status=closed&limit={limit}&offset={offset}&sort=date_created:desc",
            token,
        )
        if "_error" in pagina:
            print("Error buscando reclamos cerrados:", pagina, file=sys.stderr)
            break

        total = (pagina.get("paging") or {}).get("total", 0)
        claims = pagina.get("data", [])
        if not claims:
            break

        se_encontro_viejo = False
        for c in claims:
            if c.get("status") != "closed":
                continue
            if not fecha_es_reciente(c, limite_fecha):
                se_encontro_viejo = True
                continue
            procesar_devolucion_cerrada(c, token, devoluciones_por_revisar)

        if se_encontro_viejo:
            break  # esta pagina ya trae reclamos de hace mas de 60 dias, no hace falta seguir

        offset += limit


# --------------------------------------------------------------------------

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
    devoluciones_por_revisar = []

    buscar_reclamos_abiertos(token, user_id, urgentes, proximas_por_atender)
    buscar_devoluciones_cerradas(token, user_id, devoluciones_por_revisar)

    return {
        "generado": datetime.now(timezone.utc).isoformat(),
        "urgentes": urgentes,
        "proximas_por_atender": proximas_por_atender,
        "devoluciones_por_revisar": devoluciones_por_revisar,
    }


if __name__ == "__main__":
    data = construir_dashboard()
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"data.json actualizado: {len(data['urgentes'])} urgentes, "
          f"{len(data['proximas_por_atender'])} proximas por atender, "
          f"{len(data['devoluciones_por_revisar'])} devoluciones por revisar.")
