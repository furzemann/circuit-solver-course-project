const mongoose = require('mongoose');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const bcryptjs = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

require('dotenv').config();

// --- Constants ---
const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGOURL;
const JWT_KEY = process.env.KEY;

// --- Schemas ---
const GraphSchema = new mongoose.Schema({
    name: { type: String, required: true },
    graphData: { type: mongoose.Schema.Types.Mixed, required: true }
});

const UserSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    savedGraphs: [GraphSchema]
});

// --- Server Setup ---
const app = express();

app.use(express.json());
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(cors({
    origin: 'http://localhost:5173',
    credentials: true
}));

// --- Database ---
mongoose.connect(MONGO_URL)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB Error:", err));

const User = mongoose.model("User", UserSchema);

// --- Helpers ---
async function hashPassword(password) { return await bcryptjs.hash(password, 10); }
async function comparePasswords(plain, hashed) { return await bcryptjs.compare(plain, hashed); }
function generateToken(payload) { return jwt.sign(payload, JWT_KEY, { expiresIn: '7d' }); }

// --- Middleware ---
function verifyToken(req, res, next) {
    const token = req.cookies.token;
    if (!token) return res.status(401).json({ error: { message: 'Not authenticated' } });
    try {
        req.user = jwt.verify(token, JWT_KEY);
        next();
    } catch (err) {
        return res.status(401).json({ error: { message: 'Invalid token' } });
    }
}

// --- Netlist Converter ---
function convertGraphToNetlist(graphData) {
    const { nodes, edges } = graphData;
    if (!nodes || nodes.length === 0 || !edges || edges.length === 0) return null;

    // 1. Find Ground (lowest Y, then lowest X) to anchor the circuit
    const groundNode = nodes.reduce((lowest, node) => {
        if (node.y > lowest.y) return node;
        if (node.y === lowest.y && node.x < lowest.x) return node;
        return lowest;
    }, nodes[0]);

    const groundId = `${groundNode.x},${groundNode.y}`;

    // 2. Map nodes to names (Ground is ALWAYS '0')
    const nodeMap = new Map();
    let nodeCounter = 1;
    nodes.forEach(n => {
        const id = `${n.x},${n.y}`;
        nodeMap.set(id, id === groundId ? '0' : `n${nodeCounter++}`);
    });

    // 3. Component mapping
    const typeMap = {
        'resistor': 'R', 'capacitor': 'C', 'inductor': 'L',
        'voltage_source': 'V', 'current_source': 'I', 'wire': 'W'
    };
    const counts = { R:0, C:0, L:0, V:0, I:0, W:0 };

    // 4. Generate lines
    let netlist = "* Auto-generated netlist\n";
    edges.forEach(e => {
        let type = typeMap[e.component];
        if (!type) return;
        
        let name = `${type}${++counts[type]}`;
        let n1 = nodeMap.get(`${e.from.x},${e.from.y}`);
        let n2 = nodeMap.get(`${e.to.x},${e.to.y}`);
        let val = e.value;

        // Wires are modelled as 1 micro-ohm resistors
        if (e.component === 'wire') val = 1e-6;

        if (n1 !== undefined && n2 !== undefined) {
             netlist += `${name} ${n1} ${n2} ${val}\n`;
        }
    });

    return netlist;
}

// --- Routes ---

// Auth
app.post("/api/register", async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (await User.findOne({ $or: [{ email }, { name }] })) {
            return res.status(409).json({ error: { message: "User already exists" } });
        }
        await User.create({ name, email, password: await hashPassword(password) });
        res.status(201).json({ message: "Registered!" });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.post('/api/login', async (req, res) => {
    try {
        const { name, password } = req.body;
        const user = await User.findOne({ name });
        if (!user || !(await comparePasswords(password, user.password))) {
            return res.status(401).json({ error: { message: "Invalid credentials" } });
        }
        res.cookie('token', generateToken({ name: user.name, id: user._id }), {
            httpOnly: true, secure: false, sameSite: 'lax', maxAge: 7 * 24 * 3600000
        });
        res.json({ name: user.name });
    } catch (e) { res.status(500).json({ error: { message: e.message } }); }
});

app.post('/api/logout', (req, res) => {
    res.clearCookie('token');
    res.json({ message: "Logged out" });
});

app.get('/api/profile', verifyToken, (req, res) => res.json({ user: req.user }));

// Graphs CRUD
app.get('/api/graphs', verifyToken, async (req, res) => {
    const user = await User.findById(req.user.id, 'savedGraphs._id savedGraphs.name');
    res.json(user.savedGraphs);
});

app.post('/api/graphs', verifyToken, async (req, res) => {
    const user = await User.findById(req.user.id);
    user.savedGraphs.push(req.body);
    await user.save();
    res.json({ message: "Saved" });
});

app.get('/api/graphs/:id', verifyToken, async (req, res) => {
    const user = await User.findById(req.user.id);
    const graph = user.savedGraphs.id(req.params.id);
    graph ? res.json(graph.graphData) : res.status(404).json({error:{message:"Not found"}});
});

app.delete('/api/graphs/:id', verifyToken, async (req, res) => {
    await User.findOneAndUpdate({ _id: req.user.id }, { $pull: { savedGraphs: { _id: req.params.id } } });
    res.json({ message: "Deleted" });
});

// --- SIMULATION ROUTE ---
app.post('/api/solve-circuit', verifyToken, async (req, res) => {
    try {
        const { graphData } = req.body;
        const netlist = convertGraphToNetlist(graphData);
        if (!netlist) return res.status(400).json({ error: { message: "Empty circuit or invalid data" } });

        // Get simulation time from request, default to 0.01s (10ms) if not provided
        const t_end = graphData.simulationTime || 0.01;

        const tempDir = path.join(__dirname, 'temp', req.user.id);
        if (!fs.existsSync(tempDir)) {
            fs.mkdirSync(tempDir, { recursive: true });
        }
        
        const netFile = path.join(tempDir, 'circuit.net');
        fs.writeFileSync(netFile, netlist);

        // Pass t_end as a command line argument to python script
        const python = spawn('python', [path.join(__dirname, 'circuit_solver/main.py'), netFile, t_end.toString()]);
        
        let output = '';
        let errorOutput = '';

        python.stdout.on('data', (data) => { output += data.toString(); });
        python.stderr.on('data', (data) => { errorOutput += data.toString(); });

        python.on('close', (code) => {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch(e) {}

            if (code !== 0) {
                console.error("Python Error:", errorOutput);
                try {
                    const errObj = JSON.parse(errorOutput);
                    return res.status(400).json({ error: { message: errObj.error } });
                } catch {
                    return res.status(500).json({ error: { message: "Simulation engine failed", details: errorOutput } });
                }
            }

            try {
                res.json(JSON.parse(output));
            } catch (e) {
                console.error("JSON Parse Error:", output);
                res.status(500).json({ error: { message: "Failed to parse simulation results" } });
            }
        });

    } catch (e) {
        console.error("Server Error:", e);
        res.status(500).json({ error: { message: e.message } });
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));