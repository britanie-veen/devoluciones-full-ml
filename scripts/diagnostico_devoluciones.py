#!/usr/bin/env python3
"""
Diagnostico temporal — SOLO LECTURA.

Este script NO se usa en el tablero. Es para ver, tal cual, lo que
Mercado Libre contesta sobre cada reclamo/devolucion abierta, y asi
poder identificar que campo corresponde a Urgentes / Para tu revision /
Otros problemas en la pestaña Posventa > Devoluciones. Se puede borrar
(junto con su workflow) en cuanto ya no se necesite.

Nunca hace POST/PUT contra la API de Mercado Libre, salvo el refresh
del propio access_token (necesario para poder leer).
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
OUTPUT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "diagnostico.json")


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


def construir_diagnostico():
    tokens = refrescar_token()
    if "access_token" not in tokens:
        print("No se pudo refrescar el token:", tokens, file=sys.stderr)
        sys.exit(1)
    token = tokens["access_token"]

    me = ml_get("/users/me", token)
    user_id = me.get("id")

    crudos = []
    offset = 0
    limit = 20
    total = None
    tope_seguridad = 60  # solo necesitamos una muestra, no las 300

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

        for claim in claims:
            claim_id = claim.get("id")
            time.sleep(0.3)
            ret = ml_get(f"/post-purchase/v2/claims/{claim_id}/returns", token)
            crudos.append({
                "claim_id": claim_id,
                "resource": claim.get("resource"),
                "resource_id": claim.get("resource_id"),
                "reason_id": claim.get("reason_id"),
                "type": claim.get("type"),
                "stage": claim.get("stage"),
                "status": claim.get("status"),
                "players": claim.get("players"),
                "returns_raw": ret,
            })

        offset += limit

    return {
        "generado": datetime.now(timezone.utc).isoformat(),
        "total_encontrados": total,
        "muestra": crudos,
    }


if __name__ == "__main__":
    data = construir_diagnostico()
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
    print(f"diagnostico.json escrito con {len(data['muestra'])} reclamos de muestra.")
