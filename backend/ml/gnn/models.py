import heapq
from datetime import datetime
import logging
import networkx as nx
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch_geometric.data import Data, DataLoader
from torch_geometric.nn import GATConv, GCNConv, SAGEConv, global_mean_pool

logger = logging.getLogger(__name__)
GNN_NODE_FEATURE_DIM = 9
GNN_EDGE_FEATURE_DIM = 5

class GNNRouteModel(nn.Module):
    """Graph Neural Network for Route Optimization."""
    def __init__(self, input_dim=GNN_NODE_FEATURE_DIM, hidden_dim=128, output_dim=32, edge_dim=GNN_EDGE_FEATURE_DIM,
                 in_channels=None, hidden_channels=None, out_channels=None):
        super().__init__()
        if in_channels is not None: input_dim = in_channels
        if hidden_channels is not None: hidden_dim = hidden_channels
        if out_channels is not None: output_dim = out_channels
        self.input_dim, self.hidden_dim, self.output_dim, self.edge_dim = input_dim, hidden_dim, output_dim, edge_dim
        self.conv1 = GCNConv(input_dim, hidden_dim)
        self.conv2 = GATConv(hidden_dim, hidden_dim, heads=4, concat=True, edge_dim=edge_dim) if edge_dim else GATConv(hidden_dim, hidden_dim, heads=4, concat=True)
        self.conv3 = SAGEConv(hidden_dim * 4, hidden_dim)
        self.attention = nn.MultiheadAttention(hidden_dim, num_heads=8)
        self.lin1, self.lin2 = nn.Linear(hidden_dim, output_dim), nn.Linear(output_dim, 1)
        self.dropout = nn.Dropout(0.2)
        self.bn1, self.bn2 = nn.BatchNorm1d(hidden_dim), nn.BatchNorm1d(hidden_dim * 4)

    def forward(self, x, edge_index, edge_attr=None, batch=None):
        x = self.dropout(self.bn1(F.relu(self.conv1(x, edge_index))))
        if getattr(self, 'edge_dim', None) is not None:
            if edge_attr is None:
                edge_attr = torch.zeros((edge_index.size(1), self.edge_dim), dtype=torch.float, device=x.device)
            x = self.conv2(x, edge_index, edge_attr=edge_attr)
        else:
            x = self.conv2(x, edge_index)
        x = self.dropout(self.bn2(F.relu(x)))
        x = self.dropout(F.relu(self.conv3(x, edge_index)))
        if batch is not None:
            x = global_mean_pool(x, batch)
        return self.lin2(self.dropout(F.relu(self.lin1(x)))).squeeze()

RouteGNN = GNNRouteModel

class GraphNetworkBuilder:
    """Build directed road-network graphs for GNN routing while preserving parallel segments."""
    def __init__(self):
        self.graph = nx.MultiDiGraph()
        self.node_features = {}
        self.edge_features = {}

    def build_road_network(self, nodes, edges):
        """Build the directed road network while preserving parallel edges."""
        for node in nodes:
            self.graph.add_node(node['id'], lat=node['lat'], lng=node['lng'], traffic=node.get('traffic', 0),
                                road_type=node.get('road_type', 'local'), speed_limit=node.get('speed_limit', 50))
        for edge in edges:
            self.graph.add_edge(edge['source'], edge['target'],
                                key=edge.get('key'), distance=edge['distance'], time=edge['time'],
                                cost=edge.get('cost', 0), fuel=edge.get('fuel', 0), congestion=edge.get('congestion', 0),
                                hazmat_allowed=edge.get('hazmat_allowed', True), max_weight=edge.get('max_weight'),
                                max_height=edge.get('max_height'))
        return self.graph

    def extract_features(self):
        node_features, edge_indices, edge_features = [], [], []
        node_map = {node: i for i, (node, _) in enumerate(self.graph.nodes(data=True))}
        for _, data in self.graph.nodes(data=True):
            node_features.append([data.get('lat', 0), data.get('lng', 0), data.get('traffic', 0) / 100,
                                  *self._road_type_encoding(data.get('road_type', 'local')), data.get('speed_limit', 50) / 100])
        for u, v, _, data in self.graph.edges(data=True, keys=True):
            edge_indices.append([node_map[u], node_map[v]])
            edge_features.append([data.get('distance', 0) / 100, data.get('time', 0) / 100,
                                  data.get('cost', 0) / 1000, data.get('fuel', 0) / 100, data.get('congestion', 0)])
        self.node_map = node_map
        return {'node_features': torch.tensor(node_features, dtype=torch.float),
                'edge_indices': torch.tensor(edge_indices, dtype=torch.long).t().contiguous(),
                'edge_features': torch.tensor(edge_features, dtype=torch.float)}

    def _road_type_encoding(self, road_type):
        types = ['highway', 'arterial', 'collector', 'local', 'street']
        encoding = [0] * len(types)
        if road_type in types: encoding[types.index(road_type)] = 1
        return encoding

    def get_pytorch_data(self):
        features = self.extract_features()
        data = Data(x=features['node_features'], edge_index=features['edge_indices'], edge_attr=features['edge_features'])
        data.graph, data.node_map = self.graph, self.node_map
        return data

class RouteOptimizer:
    """GNN-based Route Optimizer."""
    def __init__(self, model_path=None):
        self.device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        self.model = GNNRouteModel().to(self.device)
        if model_path: self.load_model(model_path)

    def optimize_route(self, start_node, end_node, graph_data, objectives=['time', 'cost', 'fuel'], constraints=None):
        try:
            data = graph_data.to(self.device)
            if hasattr(self.model, 'input_dim') and data.x.shape[1] != self.model.input_dim:
                raise ValueError(f"Node feature dim mismatch: model expects {self.model.input_dim}, got {data.x.shape[1]}")
            with torch.no_grad():
                embeddings = self.model(data.x, data.edge_index, data.edge_attr)
            route = self._find_optimal_route(start_node, end_node,
                embeddings.cpu().numpy() if hasattr(embeddings, 'cpu') else np.asarray(embeddings), graph_data, objectives, constraints)
            if route is None or (start_node != end_node and (not route or route[-1]['to'] != end_node)): return None
            return self._build_route_result(route)
        except Exception as e:
            logger.error(f"Route optimization failed: {e}")
            return None

    def _build_route_result(self, route):
        return {'success': True, 'route': route,
                'total_distance': sum(r.get('distance', 0) for r in route),
                'total_time': sum(r.get('time', 0) for r in route),
                'total_cost': sum(r.get('cost', 0) for r in route),
                'total_fuel': sum(r.get('fuel', 0) for r in route),
                'nodes_visited': 1 if not route else len(route) + 1,
                'timestamp': datetime.now().isoformat()}

    def _iter_outgoing_edges(self, graph, node):
        if graph.is_multigraph():
            yield from graph.out_edges(node, keys=True, data=True)
        else:
            for neighbor, data in graph[node].items(): yield node, neighbor, None, data

    def _edge_weight(self, current, neighbor, edge_attrs, embeddings, objectives, graph_data, node_map, constraints):
        if not self._edge_is_feasible(edge_attrs, constraints): return None
        return self._calculate_score(embeddings, current, neighbor, objectives, graph_data, node_map, edge_attrs)

    def _find_optimal_route(self, start, end, embeddings, graph_data, objectives, constraints=None):
        if not hasattr(graph_data, 'graph'): return None
        graph = graph_data.graph
        if start not in graph or end not in graph: return None
        if start == end: return []
        constraints = constraints or {}
        node_map = getattr(graph_data, 'node_map', None)
        max_time = constraints.get('max_time') or constraints.get('hos_limit')
        pq = [(0.0, 0.0, 0, start, (start,), ())]
        counter, best_score, nondominated = 1, {}, {}
        selected_edge_path = None
        while pq:
            curr_score, curr_time, _, current, node_path, edge_path = heapq.heappop(pq)
            if current == end:
                selected_edge_path = edge_path; break
            if max_time is None:
                if curr_score >= best_score.get(current, float('inf')): continue
                best_score[current] = curr_score
            else:
                labels = nondominated.setdefault(current, [])
                if any(score <= curr_score and elapsed <= curr_time for score, elapsed in labels): continue
                nondominated[current] = [(score, elapsed) for score, elapsed in labels
                                         if not (curr_score <= score and curr_time <= elapsed)] + [(curr_score, curr_time)]
            for _, neighbor, edge_key, edge_attrs in self._iter_outgoing_edges(graph, current):
                if neighbor in node_path: continue
                edge_weight = self._edge_weight(current, neighbor, edge_attrs, embeddings, objectives, graph_data, node_map, constraints)
                if edge_weight is None: continue
                edge_time = float(edge_attrs.get('time', 0)); new_time = curr_time + edge_time
                if max_time is not None and new_time > max_time: continue
                heapq.heappush(pq, (curr_score + edge_weight, new_time, counter, neighbor,
                                    node_path + (neighbor,), edge_path + ((current, neighbor, edge_key, dict(edge_attrs)),)))
                counter += 1
        if selected_edge_path is None: return None
        route = []
        for u, v, key, data in selected_edge_path:
            segment = {'from': u, 'to': v, 'distance': data.get('distance', 0), 'time': data.get('time', 0),
                       'cost': data.get('cost', 0), 'fuel': data.get('fuel', 0), 'congestion': data.get('congestion', 0)}
            if key is not None: segment['edge_key'] = key
            route.append(segment)
        return route

    def _calculate_score(self, embeddings, current, neighbor, objectives, graph_data, node_map=None, edge_data=None):
        score = 0.0; edge_data = edge_data if edge_data is not None else graph_data.graph[current][neighbor]
        weights = {'time': 1.0, 'cost': 0.5, 'fuel': 0.3, 'distance': 0.2, 'congestion': 2.0}
        for obj in objectives:
            if obj in edge_data: score += weights.get(obj, 1.0) * float(edge_data[obj])
        node_map = node_map if node_map is not None else getattr(graph_data, 'node_map', None)
        if embeddings is not None and node_map and current in node_map and neighbor in node_map:
            try: score += 0.1 * float(np.linalg.norm(embeddings[node_map[current]] - embeddings[node_map[neighbor]]))
            except Exception: pass
        return max(score, 1e-6)

    def train(self, train_data, val_data=None, epochs=100):
        optimizer, criterion = torch.optim.Adam(self.model.parameters(), lr=0.001), nn.MSELoss()
        for epoch in range(epochs):
            self.model.train(); total_loss = 0.0
            for data in train_data:
                data = data.to(self.device); optimizer.zero_grad()
                loss = criterion(self.model(data.x, data.edge_index, data.edge_attr, data.batch), data.y)
                loss.backward(); optimizer.step(); total_loss += loss.item()
            avg_loss = total_loss / len(train_data)
            if epoch % 10 == 0: logger.info(f"Epoch {epoch}: Loss = {avg_loss:.4f}")
        return avg_loss

    def save_model(self, path='models/gnn_route.pth'): torch.save(self.model.state_dict(), path)
    def load_model(self, path='models/gnn_route.pth'):
        self.model.load_state_dict(torch.load(path, map_location=self.device)); self.model.eval()

    def _edge_is_feasible(self, edge_data, constraints):
        constraints = constraints or {}
        if constraints.get('hazmat', False) and not edge_data.get('hazmat_allowed', True): return False
        truck_weight = constraints.get('truck_weight') or constraints.get('weight'); max_weight = edge_data.get('max_weight') or edge_data.get('weight_limit')
        if truck_weight is not None and max_weight is not None and truck_weight > max_weight: return False
        truck_height = constraints.get('truck_height') or constraints.get('height'); max_height = edge_data.get('max_height') or edge_data.get('height_limit')
        if truck_height is not None and max_height is not None and truck_height > max_height: return False
        return True

    def _route_result_for_path(self, path, graph_data, edge_path=None):
        if edge_path is None:
            edge_path = []
            for u, v in zip(path, path[1:]):
                if graph_data.graph.is_multigraph():
                    candidates = graph_data.graph.get_edge_data(u, v)
                    if not candidates: return self._build_route_result([])
                    key, data = min(candidates.items(), key=lambda item: float(item[1].get('time', 0)))
                    edge_path.append((u, v, key, data))
                else:
                    edge_path.append((u, v, None, graph_data.graph[u][v]))
        route = []
        for u, v, key, data in edge_path:
            segment = {'from': u, 'to': v, 'distance': data.get('distance', 0), 'time': data.get('time', 0),
                       'cost': data.get('cost', 0), 'fuel': data.get('fuel', 0), 'congestion': data.get('congestion', 0)}
            if key is not None: segment['edge_key'] = key
            route.append(segment)
        return self._build_route_result(route)

    def _pareto_dominates(self, left, right, objectives):
        lv, rv = tuple(left[f'total_{o}'] for o in objectives), tuple(right[f'total_{o}'] for o in objectives)
        return all(a <= b for a, b in zip(lv, rv)) and any(a < b for a, b in zip(lv, rv))

    def _pareto_frontier(self, candidates, objectives):
        return [c for c in candidates if not any(c is not e and self._pareto_dominates(e, c, objectives) for e in candidates)]

    def _find_pareto_routes(self, start, end, graph_data, objectives, constraints=None):
        constraints = constraints or {}
        graph = getattr(graph_data, 'graph', None)
        if graph is None or start not in graph or end not in graph: return []
        if start == end: return [self._build_route_result([])]
        labels = {start: [((0.0,) * len(objectives), 0.0, (start,), ())]}
        queue, counter = [(tuple(0.0 for _ in objectives), 0.0, 0, (start,), ())], 1
        while queue:
            values, elapsed, _, node_path, edge_path = heapq.heappop(queue); current = node_path[-1]
            if current == end: continue
            for _, neighbor, key, data in self._iter_outgoing_edges(graph, current):
                if neighbor in node_path or not self._edge_is_feasible(data, constraints): continue
                new_elapsed = elapsed + float(data.get('time', 0))
                max_time = constraints.get('max_time') or constraints.get('hos_limit')
                if max_time is not None and new_elapsed > max_time: continue
                new_values = tuple(values[i] + float(data.get(objective, 0)) for i, objective in enumerate(objectives))
                new_nodes = node_path + (neighbor,); new_edges = edge_path + ((current, neighbor, key, dict(data)),)
                candidate = self._route_result_for_path(new_nodes, graph_data, new_edges)
                existing = labels.setdefault(neighbor, []); survivors = []; dominated = False
                for ev, et, en, ee in existing:
                    er = self._route_result_for_path(en, graph_data, ee)
                    if self._pareto_dominates(er, candidate, objectives): dominated = True; survivors.append((ev, et, en, ee)); continue
                    if self._pareto_dominates(candidate, er, objectives): continue
                    survivors.append((ev, et, en, ee))
                if dominated: labels[neighbor] = survivors; continue
                label = (new_values, new_elapsed, new_nodes, new_edges); survivors.append(label); labels[neighbor] = survivors
                heapq.heappush(queue, (new_values, new_elapsed, counter, new_nodes, new_edges)); counter += 1
        return self._pareto_frontier([self._route_result_for_path(n, graph_data, e) for _, _, n, e in labels.get(end, [])], objectives)

    def multi_objective_optimization(self, start, end, graph_data, constraints=None):
        objectives = ['time', 'cost', 'fuel']; frontier = self._find_pareto_routes(start, end, graph_data, objectives, constraints)
        if not frontier: return None
        weights = {'time': 0.5, 'cost': 0.3, 'fuel': 0.2}
        best = min(frontier, key=lambda c: sum(weights[o] * c[f'total_{o}'] for o in objectives))
        result = dict(best); result['pareto_routes'] = frontier; result['pareto_count'] = len(frontier); return result

    def real_time_update(self, current_route, new_traffic_data, graph_data=None, objectives=None, constraints=None):
        if not current_route: return current_route
        if graph_data is None or not hasattr(graph_data, 'graph'):
            updated = [dict(e) for e in current_route]; self._apply_traffic_to_route(updated, new_traffic_data); return updated
        graph = graph_data.graph.copy(); changed = False
        for edge_id, update in new_traffic_data.items():
            if not isinstance(update, dict): continue
            parts = edge_id.rsplit('-', 1)
            if len(parts) != 2: continue
            u, v = parts
            if u not in graph or v not in graph: continue
            edge_items = graph.get_edge_data(u, v, default={}) if graph.is_multigraph() else {None: graph.get_edge_data(u, v, default={})}
            for key, attrs in edge_items.items():
                for field in ('time', 'cost', 'fuel', 'congestion'):
                    if field in update and update[field] is not None and attrs.get(field) != float(update[field]):
                        attrs[field] = float(update[field]); changed = True
        updated_route = [dict(e) for e in current_route]; self._apply_traffic_to_route(updated_route, new_traffic_data)
        if not changed: return updated_route
        builder = GraphNetworkBuilder()
        nodes = [{'id': n, 'lat': a.get('lat', 0), 'lng': a.get('lng', 0), 'traffic': a.get('traffic', 0), 'road_type': a.get('road_type', 'local'), 'speed_limit': a.get('speed_limit', 50)} for n, a in graph.nodes(data=True)]
        edges = []
        if graph.is_multigraph():
            for u, v, key, a in graph.edges(data=True, keys=True):
                edges.append({'source': u, 'target': v, 'key': key, 'distance': a.get('distance', 0), 'time': a.get('time', 0), 'cost': a.get('cost', 0), 'fuel': a.get('fuel', 0), 'congestion': a.get('congestion', 0), 'hazmat_allowed': a.get('hazmat_allowed', True), 'max_weight': a.get('max_weight'), 'max_height': a.get('max_height')})
        else:
            for u, v, a in graph.edges(data=True): edges.append({'source': u, 'target': v, **a})
        builder.build_road_network(nodes, edges); updated_graph_data = builder.get_pytorch_data()
        start, end = current_route[0].get('from'), current_route[-1].get('to')
        if start is None or end is None: return updated_route
        rerouted = self._reoptimize(start, end, updated_graph_data, objectives or ['time', 'cost', 'fuel'], constraints)
        return rerouted if rerouted is not None else updated_route

    def _apply_traffic_to_route(self, route, traffic_data):
        for edge in route:
            update = traffic_data.get(f"{edge['from']}-{edge['to']}")
            if not isinstance(update, dict): continue
            for field in ('time', 'cost', 'fuel', 'congestion'):
                if field in update and update[field] is not None: edge[field] = float(update[field])

    def _needs_reoptimization(self, route): return any(edge.get('congestion', 0) > 0.7 for edge in route)
    def _reoptimize(self, start, end, graph_data, objectives, constraints=None):
        result = self.optimize_route(start, end, graph_data, objectives, constraints)
        return result['route'] if result and result.get('success') else None
