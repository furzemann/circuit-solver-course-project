import { useState, useRef, useEffect } from 'react';
import './App.css';
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';

// --- Constants ---
const GRID_SIZE = 16;
const SNAP_RADIUS = GRID_SIZE;
// Fallback to localhost if standard env var isn't available in this specific environment
const API_URL = 'http://localhost:3000';

// --- Component options ---
const componentOptions = [
  { id: 'wire', name: 'Wire', color: 'rgb(31 41 55)' },
  { id: 'resistor', name: 'Resistor', color: '#ef4444' },
  { id: 'voltage_source', name: 'Voltage Source', color: '#22c55e' },
  { id: 'capacitor', name: 'Capacitor', color: '#3b82f6' },
  { id: 'inductor', name: 'Inductor', color: '#f97316' }
];

const getComponentById = (id) => {
  return componentOptions.find(c => c.id === id) || componentOptions[0];
};

// --- Helper to generate component names (e.g., R1, C2) ---
const getComponentName = (index, lines) => {
  const line = lines[index];
  if (!line) return '';
  // Standard prefixes
  const typeMap = {
    resistor: 'R',
    capacitor: 'C',
    inductor: 'L',
    voltage_source: 'V',
    current_source: 'I',
    wire: 'W'
  };
  const prefix = typeMap[line.component] || '?';

  // Count how many of this same type appear before or at this index
  let count = 0;
  for (let i = 0; i <= index; i++) {
    if (lines[i].component === line.component) count++;
  }
  return `${prefix}${count}`;
};

// --- SVG Path definitions ---
const ICON_LEN = 32;
const componentPaths = {
  resistor: "M -16 0 l 4 -6 l 8 12 l 8 -12 l 8 12 l 4 -6",
  capacitor: "M -16 0 L -2 0 M 2 0 L 16 0 M -2 -8 L -2 8 M 2 -8 L 2 8",
  inductor: "M -16 0 q 4 10 8 0 q 4 -10 8 0 q 4 10 8 0 q 4 -10 8 0",
  voltage_source: "M -16 0 L -6 0 M -6 -12 L -6 12 M 6 -6 L 6 6 M 6 0 L 16 0"
};

// --- Circuit Component Renderer ---
function CircuitComponent({ x1, y1, x2, y2, component }) {
  const wireStrokeWidth = 2;
  const componentIconStrokeWidth = 2;

  return (
    <g className="circuit-component-group">
      {component.id === 'wire' ? (
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={component.color} strokeWidth={wireStrokeWidth} style={{ pointerEvents: 'none' }} />
      ) : (
        <CircuitIconRenderer
          x1={x1} y1={y1} x2={x2} y2={y2}
          component={component}
          wireStrokeWidth={wireStrokeWidth}
          componentIconStrokeWidth={componentIconStrokeWidth}
        />
      )}
    </g>
  );
}

// New: Dedicated component for rendering the actual icon and wires
function CircuitIconRenderer({ x1, y1, x2, y2, component, wireStrokeWidth, componentIconStrokeWidth }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const L = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx) * 180 / Math.PI;
  const midX = (x1 + x2) / 2;
  const midY = (y1 + y2) / 2;
  const color = component.color;
  const pathD = componentPaths[component.id];

  if (L < ICON_LEN) {
    return (
      <g className="component-icon" transform={`translate(${midX}, ${midY}) rotate(${angle}) scale(${L / ICON_LEN})`}>
        <path d={pathD} stroke={color} strokeWidth={componentIconStrokeWidth / (L / ICON_LEN)} fill="none" style={{ pointerEvents: 'none' }} />
      </g>
    );
  }

  const ux = dx / L;
  const uy = dy / L;
  const wireLen = (L - ICON_LEN) / 2;

  return (
    <g className="component-icon" style={{ pointerEvents: 'none' }}>
      <line x1={x1} y1={y1} x2={x1 + ux * wireLen} y2={y1 + uy * wireLen} stroke={color} strokeWidth={wireStrokeWidth} />
      <g transform={`translate(${midX}, ${midY}) rotate(${angle})`}>
        <path d={pathD} stroke={color} strokeWidth={componentIconStrokeWidth} fill="none" />
      </g>
      <line x1={x2 - ux * wireLen} y1={y2 - uy * wireLen} x2={x2} y2={y2} stroke={color} strokeWidth={wireStrokeWidth} />
    </g>
  );
}


function App() {
  // --- Main State ---
  const [lines, setLines] = useState([]);
  const [nodes, setNodes] = useState([]);
  const [startPoint, setStartPoint] = useState(null);
  const [currentPos, setCurrentPos] = useState(null);
  const [selectedComponentId, setSelectedComponentId] = useState('select');
  const [showComponentPanel, setShowComponentPanel] = useState(false);
  const [selectedLineInfo, setSelectedLineInfo] = useState(null);
  const [editingValue, setEditingValue] = useState(10);

  // --- Auth & Storage State ---
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [showAuthPanel, setShowAuthPanel] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [authForm, setAuthForm] = useState({ name: '', email: '', password: '' });
  const [authError, setAuthError] = useState('');
  const [showGraphsPanel, setShowGraphsPanel] = useState(false);
  const [savedGraphs, setSavedGraphs] = useState([]);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [saveGraphName, setSaveGraphName] = useState('');

  // --- Solver State ---
  const [apiError, setApiError] = useState('');
  const [solutionData, setSolutionData] = useState(null);
  const [showSolutionPanel, setShowSolutionPanel] = useState(false);
  const [selectedPlotComponent, setSelectedPlotComponent] = useState(null);
  const [chartHeight, setChartHeight] = useState(300);
  const [simulationTime, setSimulationTime] = useState(10);
  const [timeUnit, setTimeUnit] = useState('ms');
  const [hovered, setHovered] = useState(false); // local state for hover (or you can lift this up)
  const [hoveredIndex, setHoveredIndex] = useState(null);

  const mainRef = useRef(null);

  // --- UI Helpers ---
  const closeAllPanels = () => {
    setShowComponentPanel(false); setShowAuthPanel(false); setShowGraphsPanel(false);
    setShowSaveModal(false); setShowSolutionPanel(false); setApiError('');
  };

  // --- Drawing Logic ---
  const addNode = (newPos) => {
    setNodes(prev => {
      const exists = prev.some(n => n.x === newPos.x && n.y === newPos.y);
      return exists ? prev : [...prev, { ...newPos }];
    });
  };

  const getClickCoords = (e) => {
    if (!mainRef.current) return null;
    const rect = mainRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    for (const node of nodes) {
      if (Math.sqrt((x - node.x) ** 2 + (y - node.y) ** 2) <= SNAP_RADIUS) return { x: node.x, y: node.y };
    }
    const gx = Math.round(x / GRID_SIZE) * GRID_SIZE;
    const gy = Math.round(y / GRID_SIZE) * GRID_SIZE;
    return Math.sqrt((x - gx) ** 2 + (y - gy) ** 2) <= SNAP_RADIUS ? { x: gx, y: gy } : { x, y };
  };

  const handleClick = (e) => {
    if (selectedLineInfo) setSelectedLineInfo(null);
    if (!e.target.closest('.panel') && !e.target.closest('.top-controls') && !e.target.closest('.line-popup')) closeAllPanels();
    if (e.target.closest('.panel') || e.target.closest('.top-controls') || e.target.closest('.line-popup')) return;

    if (selectedComponentId === 'select') {
      return; 
    }

    const coords = getClickCoords(e);
    if (!coords) return;

    if (!startPoint) {
      setStartPoint(coords); addNode(coords); setCurrentPos(coords);
    } else {
      addNode(coords);
      const len = Math.sqrt((coords.x - startPoint.x) ** 2 + (coords.y - startPoint.y) ** 2);
      if (len > 0) {
        setLines(prev => [...prev, {
          x1: startPoint.x, y1: startPoint.y, x2: coords.x, y2: coords.y,
          component: selectedComponentId,
          value: selectedComponentId === 'wire' ? 2 : 10
        }]);
      }
      setStartPoint(null); setCurrentPos(null);
    }
  };

  const handleMouseMove = (e) => {
    if (!mainRef.current || !startPoint) return;
    const rect = mainRef.current.getBoundingClientRect();
    setCurrentPos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  // --- MODIFIED: handleLineClick now only stops propagation in 'select' mode ---
  const handleLineClick = (e, index) => {
    // If we are in 'part' mode (not 'select'), do nothing.
    // This allows the click to bubble up to the main 'handleClick'
    // which will then find the node and start a new line.
    if (selectedComponentId !== 'select') {
      return;
    }

    // If we ARE in 'select' mode, stop the click from
    // reaching the canvas and process the selection.
    e.stopPropagation();
    if (startPoint) return;

    setSelectedLineInfo({ index, x: e.clientX, y: e.clientY });
    setEditingValue(lines[index].value);
  };

  const handleDeleteLine = () => {
    if (selectedLineInfo === null) return;
    const newLines = lines.filter((_, i) => i !== selectedLineInfo.index);
    const usedPoints = new Set();
    newLines.forEach(l => {
      usedPoints.add(`${l.x1},${l.y1}`);
      usedPoints.add(`${l.x2},${l.y2}`);
    });
    const newNodes = nodes.filter(n => usedPoints.has(`${n.x},${n.y}`));
    setLines(newLines);
    setNodes(newNodes);
    setSelectedLineInfo(null);
  };

  const handleValueSave = () => {
    if (!selectedLineInfo) return;
    const idx = selectedLineInfo.index;
    if (lines[idx].component === 'wire') return;
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, value: editingValue } : l));
  };

  const handleValueKeydown = (e) => {
    if (e.key === 'Enter') { handleValueSave(); e.target.blur(); }
  };

  // --- Solver Logic ---
  const handleSolve = async () => {
    setApiError(''); setSolutionData(null); setSelectedPlotComponent(null);
    closeAllPanels(); setShowSolutionPanel(true);

    if (lines.length === 0) { setApiError("Circuit is empty."); return; }

    let timeInSeconds = simulationTime;
    if (timeUnit === 'hr') timeInSeconds *= 3660;
    if (timeUnit === 'min') timeInSeconds *= 60;
    if (timeUnit === 'ms') timeInSeconds /= 1000;
    if (timeUnit === 'µs') timeInSeconds /= 1e6;

    const graphData = {
      nodes,
      edges: lines.map(l => ({ from: { x: l.x1, y: l.y1 }, to: { x: l.x2, y: l.y2 }, component: l.component, value: l.value })),
      simulationTime: timeInSeconds
    };

    try {
      const res = await fetch(`${API_URL}/api/solve-circuit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ graphData })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || 'Solver failed');

      // Transform data for Recharts. Scale time back to selected unit for display
      let timeScaler = 1;
      if (timeUnit === 'hr') timeScaler = 3600;
      if (timeUnit === 'min') timeScaler = 60;
      if (timeUnit === 'ms') timeScaler = 1000;
      if (timeUnit === 'µs') timeScaler = 1e6;

      const timeArray = data.time;
      const chartData = timeArray.map((t, i) => {
        const point = { time: t * timeScaler };
        Object.keys(data).forEach(key => {
          if (key !== 'time') {
            point[`V_${key}`] = data[key].v[i];
            point[`I_${key}`] = data[key].i[i] * 1000; // A -> mA. Keep current in mA for now, or make it dynamic too?
          }
        });
        return point;
      });

      const components = Object.keys(data).filter(k => k !== 'time');
      setSolutionData({ chartData, components, displayUnit: timeUnit });
      if (components.length > 0) setSelectedPlotComponent(components[0]);

    } catch (err) {
      setApiError(err.message);
    }
  };

  // --- Auth & Storage Handlers ---
  const loadGraphIntoState = (data) => { if (!data) return; setNodes(data.nodes || []); setLines((data.edges || []).map(e => ({ x1: e.from.x, y1: e.from.y, x2: e.to.x, y2: e.to.y, component: e.component || 'wire', value: e.value || 10 }))); closeAllPanels(); };
  const handleAuthFormChange = (e) => setAuthForm(prev => ({ ...prev, [e.target.name]: e.target.value }));
  const handleLogin = async (e) => { e.preventDefault(); try { const res = await fetch(`${API_URL}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: authForm.name, password: authForm.password }), credentials: 'include' }); if (res.ok) { const d = await res.json(); setIsLoggedIn(true); setCurrentUser(d.name); closeAllPanels(); } else setAuthError('Login failed'); } catch (err) { setAuthError(err.message); } };
  const handleRegister = async (e) => { e.preventDefault(); try { const res = await fetch(`${API_URL}/api/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(authForm) }); if (res.ok) setAuthMode('login'); else setAuthError('Failed'); } catch (err) { setAuthError(err.message); } };
  const handleLogout = async () => { await fetch(`${API_URL}/api/logout`, { method: 'POST', credentials: 'include' }); setIsLoggedIn(false); setCurrentUser(null); closeAllPanels(); };
  const fetchSavedGraphs = async () => { const res = await fetch(`${API_URL}/api/graphs`, { credentials: 'include' }); if (res.ok) setSavedGraphs(await res.json()); };
  const handleConfirmSave = async () => { if (!saveGraphName) return; const graphData = { nodes, edges: lines.map(l => ({ from: { x: l.x1, y: l.y1 }, to: { x: l.x2, y: l.y2 }, component: l.component, value: l.value })) }; await fetch(`${API_URL}/api/graphs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include', body: JSON.stringify({ name: saveGraphName, graphData }) }); setShowSaveModal(false); };
  const handleLoadGraph = async (id) => { const res = await fetch(`${API_URL}/api/graphs/${id}`, { credentials: 'include' }); if (res.ok) loadGraphIntoState(await res.json()); };
  const handleDeleteGraph = async (id) => { if (window.confirm('Delete?')) { await fetch(`${API_URL}/api/graphs/${id}`, { method: 'DELETE', credentials: 'include' }); setSavedGraphs(prev => prev.filter(g => g._id !== id)); } };

  useEffect(() => { fetch(`${API_URL}/api/profile`, { credentials: 'include' }).then(res => { if (res.ok) res.json().then(d => { setIsLoggedIn(true); setCurrentUser(d.user.name); }); }).catch(() => { }); }, []);

  // --- Formatter for noisy data ---
  const formatNumber = (num) => {
    if (Math.abs(num) < 1e-10) return '0';
    if (Math.abs(num) >= 1000 || Math.abs(num) < 0.01) return num.toExponential(2);
    return num.toPrecision(4);
  };

  return (
    <>
      <div
        ref={mainRef}
        className={`main ${selectedComponentId === 'select' ? 'select-mode' : ''}`}
        onClick={handleClick}
        onMouseMove={handleMouseMove}
      >
        {/* --- Top Controls --- */}
        <div className="top-controls">
          {isLoggedIn ? (
            <>
              <span className="welcome-user">Hi, {currentUser}</span>
              <button className="ui-button" onClick={() => { closeAllPanels(); setShowGraphsPanel(true); fetchSavedGraphs(); }}>Circuits</button>
              <button className="ui-button" onClick={() => { closeAllPanels(); setShowSaveModal(true); }}>Save</button>
              
              <button
                className={`ui-button ${selectedComponentId === 'select' ? 'active' : ''}`}
                onClick={() => {
                  setSelectedComponentId('select');
                  setShowComponentPanel(false);
                }}
              >
                Select
              </button>
              
              <button
                className={`ui-button ${showComponentPanel ? 'active' : ''}`}
                onClick={() => {
                  closeAllPanels();
                  setShowComponentPanel(true);
                  // --- NEW: Deselect 'select' tool when opening parts ---
                  if (selectedComponentId === 'select') {
                    setSelectedComponentId(componentOptions[0].id); // Default to wire
                  }
                }}
              >
                Parts
              </button>

              <button className="ui-button solve-button" onClick={handleSolve}>Simulate</button>
              <button className="ui-button" onClick={handleLogout}>Logout</button>
            </>
          ) : (
            <>
              <button
                className={`ui-button ${selectedComponentId === 'select' ? 'active' : ''}`}
                onClick={() => {
                  setSelectedComponentId('select');
                  setShowComponentPanel(false);
                }}
              >
                Select
              </button>
              
              <button
                className={`ui-button ${showComponentPanel ? 'active' : ''}`}
                onClick={() => {
                  closeAllPanels();
                  setShowComponentPanel(true);
                  // --- NEW: Deselect 'select' tool when opening parts ---
                  if (selectedComponentId === 'select') {
                    setSelectedComponentId(componentOptions[0].id); // Default to wire
                  }
                }}
              >
                Parts
              </button>
              <button className="ui-button" onClick={() => { closeAllPanels(); setShowAuthPanel(true); }}>Login</button>
            </>
          )}
        </div>

        {/* --- Panels --- */}
        {showAuthPanel && <div className="panel auth-panel"><h3>{authMode.toUpperCase()}</h3><form onSubmit={authMode === 'login' ? handleLogin : handleRegister}><input name="name" value={authForm.name} onChange={handleAuthFormChange} placeholder="Username" required />{authMode === 'register' && <input name="email" type="email" value={authForm.email} onChange={handleAuthFormChange} placeholder="Email" required />}<input name="password" type="password" value={authForm.password} onChange={handleAuthFormChange} placeholder="Password" required /><button className="load-button">{authMode === 'login' ? 'Login' : 'Register'}</button></form><button className="link-button" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>Switch Mode</button>{authError && <p className="import-error">{authError}</p>}</div>}
        {showSaveModal && <div className="panel save-modal"><h3>Save</h3><input value={saveGraphName} onChange={e => setSaveGraphName(e.target.value)} placeholder="Name" /><div className="save-modal-buttons"><button className="ui-button" onClick={() => setShowSaveModal(false)}>Cancel</button><button className="load-button" onClick={handleConfirmSave}>Save</button></div></div>}
        {showGraphsPanel && <div className="panel graphs-panel"><h3>Circuits</h3><ul className="graphs-list">{savedGraphs.map(g => <li key={g._id}><span>{g.name}</span><div className="graph-buttons"><button onClick={() => handleLoadGraph(g._id)}>Load</button><button className="delete-graph-btn" onClick={() => handleDeleteGraph(g._id)}>X</button></div></li>)}</ul></div>}
        
        {showComponentPanel && (
          <div className="panel component-panel">
            <h3>Parts</h3>
            <div className="component-swatches">
              {componentOptions.map(c => (
                <button
                  key={c.id}
                  className="component-swatch"
                  onClick={() => setSelectedComponentId(c.id)}
                >
                  <div 
                    className="component-swatch-color" 
                    style={{ backgroundColor: c.color }} 
                    data-selected={selectedComponentId === c.id}
                  ></div>
                  <span className="component-swatch-name">{c.name}</span>
                </button>
              ))}
            </div>
          </div>
        )}


        {/* --- Solution Panel (Charts) --- */}
        {showSolutionPanel && (
          <div className="panel solution-panel">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
              <h3 style={{ margin: 0 }}>Results</h3>
              <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                <label style={{ fontSize: '0.8rem' }}>Time:</label>
                <input
                  type="number"
                  value={simulationTime}
                  onChange={(e) => setSimulationTime(Number(e.target.value))}
                  style={{ width: '50px', padding: '2px 4px', border: '1px solid #ccc', borderRadius: '4px' }}
                />
                <select
                  value={timeUnit}
                  onChange={(e) => setTimeUnit(e.target.value)}
                  style={{ padding: '2px 4px', border: '1px solid #ccc', borderRadius: '4px', marginRight: '8px' }}
                >
                  <option value="hr">hr</option>
                  <option value="min">min</option>
                  <option value="s">s</option>
                  <option value="ms">ms</option>
                  <option value="µs">µs</option>
                </select>
                <button className="ui-button solve-button" style={{ padding: '4px 8px', fontSize: '0.8rem' }} onClick={handleSolve}>Run</button>
                <button className="delete-graph-btn" onClick={() => setShowSolutionPanel(false)}>X</button>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '10px' }}>
              <button className="ui-button" style={{ padding: '2px 8px', marginRight: '4px' }} onClick={() => setChartHeight(h => Math.max(h - 50, 150))}>- Height</button>
              <button className="ui-button" style={{ padding: '2px 8px' }} onClick={() => setChartHeight(h => Math.min(h + 50, 600))}>+ Height</button>
            </div>

            {apiError && <p className="import-error">{apiError}</p>}
            {!solutionData && !apiError && <p>Running simulation...</p>}
            {solutionData && (
              <>
                <div className="chart-controls">
                  <label>Component:</label>
                  <select value={selectedPlotComponent || ''} onChange={(e) => setSelectedPlotComponent(e.target.value)}>
                    {solutionData.components.map(name => <option key={name} value={name}>{name}</option>)}
                  </select>
                </div>
                {selectedPlotComponent && (
                  <div className="chart-container">

                    <ResponsiveContainer width="100%" height={chartHeight}>
                      <LineChart data={solutionData.chartData} syncId="circuit-sync" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis dataKey="time" label={{ value: `Time (${solutionData.displayUnit})`, position: 'insideBottomRight', offset: -5, fill: '#374151', fontSize: 12 }} tick={{ fontSize: 10, fill: '#374151' }} stroke="#9ca3af" />
                        <YAxis
                          label={{ value: 'Voltage (V)', angle: -90, position: 'insideLeft', fill: '#374151', fontSize: 12 }}
                          tick={{ fontSize: 10, fill: '#374151' }}
                          stroke="#9ca3af"
                          domain={[(dataMin) => dataMin - Math.abs(dataMin) * 0.05 || dataMin - 1, (dataMax) => dataMax + Math.abs(dataMax) * 0.05 || dataMax + 1]}
                          tickFormatter={formatNumber}
                        />
                        <Tooltip contentStyle={{ backgroundColor: '#fff', borderColor: '#e5e7eb', fontSize: '12px', color: '#111827' }} itemStyle={{ color: '#111827' }} labelFormatter={(t) => `Time: ${t.toFixed(3)}${solutionData.displayUnit}`} formatter={formatNumber} />
                        <Legend verticalAlign="top" height={36} />
                        <Line name={`V(${selectedPlotComponent})`} type="monotone" dataKey={`V_${selectedPlotComponent}`} stroke="#8884d8" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>

                    <ResponsiveContainer width="100%" height={chartHeight}>
                      <LineChart data={solutionData.chartData} syncId="circuit-sync" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                        <XAxis dataKey="time" label={{ value: `Time (${solutionData.displayUnit})`, position: 'insideBottomRight', offset: -5, fill: '#374151', fontSize: 12 }} tick={{ fontSize: 10, fill: '#374151' }} stroke="#9ca3af" />
                        <YAxis
                          label={{ value: 'Current (mA)', angle: -90, position: 'insideLeft', fill: '#374151', fontSize: 12 }}
                          tick={{ fontSize: 10, fill: '#374151' }}
                          stroke="#9ca3af"
                          domain={[(dataMin) => dataMin - Math.abs(dataMin) * 0.05 || dataMin - 1, (dataMax) => dataMax + Math.abs(dataMax) * 0.05 || dataMax + 1]}
                          tickFormatter={formatNumber}
                        />
                        <Tooltip contentStyle={{ backgroundColor: '#fff', borderColor: '#e5e7eb', fontSize: '12px', color: '#111827' }} itemStyle={{ color: '#111827' }} labelFormatter={(t) => `Time: ${t.toFixed(3)}${solutionData.displayUnit}`} formatter={formatNumber} />
                        <Legend verticalAlign="top" height={36} />
                        <Line name={`I(${selectedPlotComponent})`} type="monotone" dataKey={`I_${selectedPlotComponent}`} stroke="#82ca9d" strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* --- Popups & Canvas --- */}
        {selectedLineInfo && (
          <div className="line-popup" style={{ top: selectedLineInfo.y + 10, left: selectedLineInfo.x + 10 }} onClick={e => e.stopPropagation()}>
            <div className="line-popup-header">
              <div className="line-popup-color-swatch" style={{ backgroundColor: getComponentById(lines[selectedLineInfo.index].component).color }}></div>
              <span className="line-popup-component-name">
                {getComponentName(selectedLineInfo.index, lines)}: {getComponentById(lines[selectedLineInfo.index].component).name}
              </span>
            </div>
            <div className="line-popup-value">
              <label>Val:</label>
              <input type="text" value={editingValue} onChange={e => setEditingValue(e.target.value)} onBlur={handleValueSave} onKeyDown={handleValueKeydown} disabled={lines[selectedLineInfo.index].component === 'wire'} />
            </div>
            <button className="delete-button" onClick={handleDeleteLine}>Delete</button>
          </div>
        )}

        <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0 }}>
          {nodes.map((n, i) => <circle key={`n${i}`} cx={n.x} cy={n.y} r="5" fill="#374151" style={{ pointerEvents: 'none' }} />)}
          {lines.map((l, i) => {
            const comp = getComponentById(l.component);
            const hovered = hoveredIndex === i; // global state for hover tracking
            return (
              <g
                key={i}
                onMouseEnter={() => setHoveredIndex(i)}
                onMouseLeave={() => setHoveredIndex(null)}
                onClick={(e) => handleLineClick(e, i)}
                style={{ cursor: selectedComponentId === 'select' ? 'pointer' : 'inherit' }}
              >
                {/* Invisible hitbox for easy hover/click detection */}
                <rect
                  x={Math.min(l.x1, l.x2) - 12}
                  y={Math.min(l.y1, l.y2) - 12}
                  width={Math.abs(l.x2 - l.x1) + 24}
                  height={Math.abs(l.y2 - l.y1) + 24}
                  fill="transparent"
                  pointerEvents="all"
                />

                {/* Static component (never moves) */}
                <g pointerEvents="none">
                  <CircuitComponent
                    x1={l.x1}
                    y1={l.y1}
                    x2={l.x2}
                    y2={l.y2}
                    component={comp}
                    hovered={hovered}
                  />
                </g>
              </g>
            );
          })}


          {startPoint && currentPos && <line x1={startPoint.x} y1={startPoint.y} x2={currentPos.x} y2={currentPos.y} stroke="#6b7280" strokeWidth="2" strokeDasharray="4 4" style={{ pointerEvents: 'none' }} />}
        </svg>
        <div style={{ zIndex: 1 }}><h1>Circuit Builder</h1></div>
      </div>
    </>
  );
}

export default App;