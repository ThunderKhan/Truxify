from . import models as _models
from routes import gnn_routes as _routes

_BaseGraphNetworkBuilder = _models.GraphNetworkBuilder
_BaseRouteOptimizer = _models.RouteOptimizer


class GraphNetworkBuilder(_BaseGraphNetworkBuilder):
    """Preserve unknown hazmat permissions instead of defaulting to allowed."""

    def build_road_network(self, nodes, edges):
        normalized_edges = []
        for edge in edges:
            item = dict(edge)
            if "hazmat_allowed" not in item:
                item["hazmat_allowed"] = None
            normalized_edges.append(item)
        return super().build_road_network(nodes, normalized_edges)


class RouteOptimizer(_BaseRouteOptimizer):
    """Reject hazmat edges unless permission is explicitly True."""

    def _edge_is_feasible(self, edge_data, constraints):
        if constraints.get("hazmat", False) and edge_data.get("hazmat_allowed") is not True:
            return False
        return super()._edge_is_feasible(edge_data, constraints)


_models.GraphNetworkBuilder = GraphNetworkBuilder
_models.RouteOptimizer = RouteOptimizer


# Pydantic v2 exposes field defaults through model_fields. Keep the API model
# fail-closed as well so an omitted value remains an explicit unknown.
try:
    field = _routes.Edge.model_fields["hazmat_allowed"]
    field.default = None
except (AttributeError, KeyError):
    try:
        _routes.Edge.__fields__["hazmat_allowed"].default = None
    except (AttributeError, KeyError):
        pass
