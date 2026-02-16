const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs-extra');

// Import bot (will start automatically)
const { botAPI, isBotReady } = require('./bot/index');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: { origin: "*" }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// Constants
const ADMIN_SECRET = '#6287717274346';
const activeSessions = new Map();

// Auth Middleware
const requireAuth = (req, res, next) => {
    const sessionId = req.headers.sessionid || req.body.sessionId;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    req.session = session;
    next();
};

const requireAdmin = (req, res, next) => {
    if (!req.session || req.session.role !== 'admin') {
        return res.status(403).json({ error: 'Admin only' });
    }
    next();
};

// Routes

// Health check
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        botReady: isBotReady(),
        timestamp: Date.now()
    });
});

// Request OTP
app.post('/api/auth/otp', async (req, res) => {
    try {
        const { phone, email, adminCode } = req.body;
        
        // Admin login
        if (adminCode === ADMIN_SECRET) {
            return res.json({ success: true, isAdmin: true });
        }
        
        // Regular OTP
        if (phone) {
            await botAPI.sendOTP(phone);
        }
        
        res.json({ success: true, message: 'OTP sent' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Verify OTP
app.post('/api/auth/verify', async (req, res) => {
    try {
        const { phone, email, code, adminCode } = req.body;
        
        // Admin verification
        if (adminCode === ADMIN_SECRET) {
            const sessionId = generateId();
            const adminData = {
                id: 'admin',
                name: 'Administrator',
                role: 'admin',
                sessionId,
                createdAt: Date.now()
            };
            activeSessions.set(sessionId, adminData);
            
            return res.json({
                success: true,
                isAdmin: true,
                sessionId,
                user: adminData
            });
        }
        
        // Regular verification
        const target = phone || email;
        const result = botAPI.verifyOTP(target, code);
        
        if (!result.valid) {
            return res.status(400).json({ error: result.message });
        }
        
        const sessionId = generateId();
        const userData = {
            id: generateId(),
            name: target,
            phone: phone || null,
            email: email || null,
            role: 'user',
            sessionId,
            createdAt: Date.now()
        };
        
        activeSessions.set(sessionId, userData);
        botAPI.registerUser(target, userData);
        
        res.json({
            success: true,
            sessionId,
            user: userData
        });
        
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Admin Routes
app.get('/api/admin/stats', requireAuth, requireAdmin, (req, res) => {
    res.json(botAPI.getStats());
});

app.get('/api/admin/users', requireAuth, requireAdmin, (req, res) => {
    res.json(botAPI.getUsers());
});

app.post('/api/admin/send', requireAuth, requireAdmin, async (req, res) => {
    const { phone, message } = req.body;
    const result = await botAPI.sendNotification(phone, message);
    res.json({ success: result });
});

app.post('/api/admin/broadcast', requireAuth, requireAdmin, async (req, res) => {
    const { message } = req.body;
    await botAPI.broadcast(message);
    res.json({ success: true });
});

app.post('/api/admin/otp', requireAuth, requireAdmin, async (req, res) => {
    const { phone, code } = req.body;
    await botAPI.sendOTP(phone, code);
    res.json({ success: true });
});

// Socket.io
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('authenticate', (sessionId) => {
        const session = activeSessions.get(sessionId);
        if (session) {
            socket.sessionId = sessionId;
            socket.join(session.id);
        }
    });
    
    socket.on('send_message', async (data) => {
        // Handle real-time messaging
        io.to(data.chatId).emit('new_message', data);
    });
});

// Helper
function generateId() {
    return Math.random().toString(36).substring(2, 15) + Date.now().toString(36);
}

// Start
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Bot status: ${isBotReady() ? 'Ready' : 'Starting...'}`);
});
