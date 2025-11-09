import numpy as np
import re

# --- GLOBAL PARAMETERS ---
MAX_ITERATIONS = 200
TOLERANCE = 1e-9
VT = 0.02585

# --- HELPER FUNCTIONS ---
def parse_source_function(definition):
    # Accept numeric types directly
    if isinstance(definition, (int, float)):
        return lambda t: float(definition)

    s = str(definition).strip()
    # If string is just a number e.g. "10" or "10.0"
    try:
        val = float(s)
        return lambda t: val
    except Exception:
        pass

    # SIN(V0 VP F)
    m = re.match(r'(?i)SIN\(\s*([^\s,]+)\s+([^\s,]+)\s+([^\s,]+)\s*\)', s)
    if m:
        vo, vp, f = map(float, m.groups())
        return lambda t: vo + vp * np.sin(2.0 * np.pi * f * t)

    # fallback: zero source
    return lambda t: 0.0

# --- COMPONENT CLASSES ---
class Node:
    def __init__(self, index, name):
        self.index = index
        self.name = name

class Element:
    def __init__(self, name, n1, n2):
        self.name = name; self.n1 = n1; self.n2 = n2
    def stamp(self, j, f, x_k, dt, t): pass
    def get_results(self, x_k, dt, t): return 0.0, 0.0

class Resistor(Element):
    def __init__(self, name, val, n1, n2):
        super().__init__(name, n1, n2)
        self.g = 1.0 / float(val)
    def stamp(self, j, f, x_k, dt, t):
        n1, n2 = self.n1.index, self.n2.index
        j[n1, n1] += self.g; j[n2, n2] += self.g
        j[n1, n2] -= self.g; j[n2, n1] -= self.g
        # residual (KCL) contribution using current state x_k
        f[n1] += self.g * (x_k[n1] - x_k[n2])
        f[n2] += self.g * (x_k[n2] - x_k[n1])
    def get_results(self, x_k, dt, t):
        v = float(x_k[self.n1.index] - x_k[self.n2.index])
        return v, v * self.g

class Capacitor(Element):
    def __init__(self, name, val, n1, n2):
        super().__init__(name, n1, n2)
        self.C = float(val)
        self.v_prev = 0.0
        self.i_prev = 0.0

    def stamp(self, j, f, x_k, dt, t):
        n1, n2 = self.n1.index, self.n2.index
        geq = 2.0 * self.C / dt
        ieq = -geq * self.v_prev - self.i_prev   # correct sign for BTR

        j[n1, n1] += geq
        j[n2, n2] += geq
        j[n1, n2] -= geq
        j[n2, n1] -= geq

        # residual (KCL) using current x_k
        i_branch = geq * (x_k[n1] - x_k[n2]) + ieq
        f[n1] += i_branch
        f[n2] -= i_branch

    def get_results(self, x_k, dt, t):
        v = float(x_k[self.n1.index] - x_k[self.n2.index])
        geq = 2.0 * self.C / dt
        ieq = -geq * self.v_prev - self.i_prev
        i = geq * v + ieq
        return v, i

    def update_state(self, v, i):
        self.v_prev = float(v)
        self.i_prev = float(i)

class Inductor(Element):
    def __init__(self, name, val, n1, n2, aux_idx):
        super().__init__(name, n1, n2)
        self.L = float(val)
        self.v_prev = 0.0
        self.i_prev = 0.0
        self.aux_idx = aux_idx  # auxiliary current variable index

    def stamp(self, j, f, x_k, dt, t):
        n1, n2, m = self.n1.index, self.n2.index, self.aux_idx

        Req = 2.0 * self.L / dt
        Veq = -Req * self.i_prev - self.v_prev

        # KCLs
        j[n1, m] += 1
        j[n2, m] -= 1

        # Inductor voltage equation
        j[m, n1] += 1
        j[m, n2] -= 1
        j[m, m] -= Req

        # Residuals
        f[n1] += x_k[m]
        f[n2] -= x_k[m]
        f[m] += (x_k[n1] - x_k[n2]) - Req * x_k[m] - Veq

    def get_results(self, x_k, dt, t):
        v = float(x_k[self.n1.index] - x_k[self.n2.index])
        i = float(x_k[self.aux_idx])
        return v, i

    def update_state(self, v, i):
        self.v_prev = v
        self.i_prev = i


class VoltageSource(Element):
    def __init__(self, name, val_func, n1, n2, aux_idx):
        super().__init__(name, n1, n2)
        self.val_func = val_func; self.aux_idx = aux_idx
    def stamp(self, j, f, x_k, dt, t):
        n1, n2, m = self.n1.index, self.n2.index, self.aux_idx
        # KCL: I_aux leaves n1, enters n2
        j[n1, m] += 1; j[n2, m] -= 1
        # Constraint: V_n1 - V_n2 = V_src
        j[m, n1] += 1; j[m, n2] -= 1

        # Residual: include current unknown x_k[m] in node KCL and constraint residual
        f[n1] += x_k[m]
        f[n2] -= x_k[m]
        f[m] += (x_k[n1] - x_k[n2]) - self.val_func(t)

    def get_results(self, x_k, dt, t):
        v = float(x_k[self.n1.index] - x_k[self.n2.index])
        # current through source is the auxiliary unknown (with sign)
        return v, -float(x_k[self.aux_idx])

class CircuitSolver:
    def __init__(self):
        self.nodes = {'0': Node(0, '0')}
        self.elements = []
        self.node_count = 1
        self.aux_count = 0

    def get_node(self, name):
        if name not in self.nodes:
            self.nodes[name] = Node(self.node_count, name)
            self.node_count += 1
        return self.nodes[name]

    def add_element(self, type_char, name, n1, n2, val):
        node1, node2 = self.get_node(n1), self.get_node(n2)
        if type_char == 'R':
            self.elements.append(Resistor(name, val, node1, node2))
        elif type_char == 'C':
            self.elements.append(Capacitor(name, val, node1, node2))
        elif type_char == 'L':
            self.elements.append(Inductor(name, val, node1, node2, 0))
            self.aux_count += 1
        elif type_char == 'V':
            # aux index will be assigned later in run_transient
            self.elements.append(VoltageSource(name, parse_source_function(val), node1, node2, 0))
            self.aux_count += 1

    def run_transient(self, t_end, dt):
        # total number of equations = node_count + number of voltage-aux variables
        num_eq = self.node_count + self.aux_count

        # assign aux indices (after nodes are known)
        cur_aux = self.node_count
        for el in self.elements:
            if isinstance(el, (VoltageSource, Inductor)):
                el.aux_idx = cur_aux
                cur_aux += 1

        # ensure counts match
        assert cur_aux == num_eq, "aux indexing mismatch"

        # include t_end
        times = np.arange(0.0, t_end + dt, dt)
        x = np.zeros(num_eq)

        # initialize aux variables with small values to help converge
        for el in self.elements:
            if isinstance(el, VoltageSource):
                x[el.aux_idx] = 0.0

        res = {el.name: {'v': [], 'i': []} for el in self.elements}
        res['time'] = times.tolist()

        for t in times:
            for _ in range(MAX_ITERATIONS):
                j = np.zeros((num_eq, num_eq))
                f = np.zeros(num_eq)

                # ground constraint (node '0' has index 0)
                j[0, 0] = 1.0
                f[0] = x[0]

                for el in self.elements:
                    el.stamp(j, f, x, dt, t)

                # solve J dx = -f
                try:
                    dx = np.linalg.solve(j, -f)
                except np.linalg.LinAlgError:
                    dx, *_ = np.linalg.lstsq(j, -f, rcond=None)

                x += dx
                if np.linalg.norm(dx) < TOLERANCE:
                    break

            # collect results and update states
            for el in self.elements:
                v, i = el.get_results(x, dt, t)
                res[el.name]['v'].append(float(v))
                res[el.name]['i'].append(float(i))
                if hasattr(el, 'update_state'):
                    el.update_state(v, i)

        return res
