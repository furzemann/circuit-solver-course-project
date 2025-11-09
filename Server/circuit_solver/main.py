import sys
import json
import numpy as np
from engine import CircuitSolver

def read_netlist(filepath, solver):
    with open(filepath, 'r') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('*'):
                continue
            parts = line.split()
            if len(parts) >= 4:
                name = parts[0]
                type_char = name[0].upper()
                # Treat 'W' (Wire) as 'R' (Resistor) for the solving engine, 
                # but keep the original name (e.g., W1) for the results.
                solver_type = 'R' if type_char == 'W' else type_char
                solver.add_element(solver_type, name, parts[1], parts[2], " ".join(parts[3:]))

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No netlist file provided"}))
        sys.exit(1)

    netlist_path = sys.argv[1]
    # Read t_end from command line argument, default to 0.01s if not provided
    t_end = float(sys.argv[2]) if len(sys.argv) > 2 else 0.01

    try:
        solver = CircuitSolver()
        read_netlist(netlist_path, solver)

        # Run simulation with provided t_end. 
        # Dynamically adjust time step based on total duration to keep points manageable (~1000 points)
        dt = t_end / 1000.0
        results = solver.run_transient(t_end=t_end, dt=dt)

        # Convert numpy floats to native python floats (JSON safe)
        for k, v in results.items():
            if k == 'time':
                results['time'] = [float(x) for x in results['time']]
            else:
                results[k]['v'] = [float(x) for x in v['v']]
                results[k]['i'] = [float(x) for x in v['i']]

        print(json.dumps(results))

    except Exception as e:
        # Print error to stderr so main process can distinguish it from normal output
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)