import os
import requests
import logging
import math
from typing import Tuple, List

logger = logging.getLogger(__name__)

# Defaults to the docker-compose internal hostname: http://osrm:5000
OSRM_BASE_URL = os.getenv("OSRM_BASE_URL", "http://osrm:5000")


def _haversine_distance_km(origin: Tuple[float, float], destination: Tuple[float, float]) -> float:
    from math import radians, sin, cos, sqrt, atan2

    lat1, lon1 = radians(origin[0]), radians(origin[1])
    lat2, lon2 = radians(destination[0]), radians(destination[1])
    dlon = lon2 - lon1
    dlat = lat2 - lat1
    a = sin(dlat / 2) ** 2 + cos(lat1) * cos(lat2) * sin(dlon / 2) ** 2
    c = 2 * atan2(sqrt(a), sqrt(1 - a))
    return 6371.0 * c


def get_route_distance_with_source(
    origin: Tuple[float, float],
    destination: Tuple[float, float],
) -> Tuple[float, float, bool]:
    """Return route distance/duration plus whether OSRM supplied the result."""
    try:
        # OSRM expects coordinates in lng,lat format
        url = f"{OSRM_BASE_URL}/route/v1/driving/{origin[1]},{origin[0]};{destination[1]},{destination[0]}"
        params = {
            "overview": "false",
            "alternatives": "false",
            "steps": "false",
        }
        response = requests.get(url, params=params, timeout=5)
        if response.status_code == 200:
            data = response.json()
            routes = data.get("routes") or []
            if routes:
                route = routes[0]
                distance_m = route.get("distance")
                duration_s = route.get("duration")
                if (
                    isinstance(distance_m, (int, float))
                    and isinstance(duration_s, (int, float))
                    and math.isfinite(distance_m)
                    and math.isfinite(duration_s)
                    and distance_m >= 0
                    and duration_s >= 0
                ):
                    return distance_m / 1000.0, duration_s / 60.0, True
        logger.warning("OSRM request failed with status: %s", response.status_code)
    except Exception as exc:
        logger.error("Error fetching route from OSRM: %s", exc)

    # Preserve the existing safe fallback when the road router is unavailable.
    distance_km = _haversine_distance_km(origin, destination)
    duration_min = (distance_km / 40.0) * 60.0
    return distance_km, duration_min, False


def get_route_distance(origin: Tuple[float, float], destination: Tuple[float, float]) -> Tuple[float, float]:
    """
    Gets the road route distance (km) and duration (minutes) from OSRM.

    :param origin: Tuple of (lat, lng)
    :param destination: Tuple of (lat, lng)
    :return: Tuple of (distance_km, duration_min)
    """
    distance_km, duration_min, _ = get_route_distance_with_source(origin, destination)
    return distance_km, duration_min


def get_route_matrix(locations: List[Tuple[float, float]]) -> List[List[float]]:
    """
    Gets a distance matrix in km for Vehicle Routing Problem (VRP).

    :param locations: List of (lat, lng) coordinates
    :return: 2D list representing the distance matrix in km
    """
    try:
        # OSRM table service expects coordinates in lng,lat separated by semicolon
        coord_str = ";".join([f"{loc[1]},{loc[0]}" for loc in locations])
        url = f"{OSRM_BASE_URL}/table/v1/driving/{coord_str}"
        params = {
            "annotations": "distance"
        }
        response = requests.get(url, params=params, timeout=5)
        if response.status_code == 200:
            data = response.json()
            if "distances" in data:
                # OSRM returns distances in meters, convert to km
                return [[d / 1000.0 for d in row] for row in data["distances"]]

        logger.warning(f"OSRM table request failed with status: {response.status_code}")
    except Exception as e:
        logger.error(f"Error fetching distance matrix from OSRM: {e}")

    n = len(locations)
    matrix = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i != j:
                matrix[i][j] = _haversine_distance_km(locations[i], locations[j])
    return matrix
