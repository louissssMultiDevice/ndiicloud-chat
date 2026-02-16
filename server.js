const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs-extra');
const { v4: uuidv4 } = require('uuid');
const { startBot, botAPI, isBotReady } = require('./index');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));

// Data files
const DATA_DIR = './data';
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const NOTIFICATIONS_FILE = path.join(DATA_DIR, 'notifications.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR);
}

// Initialize files
[USERS_FILE, MESSAGES_FILE, SETTINGS_FILE, NOTIFICATIONS_FILE].forEach(file => {
    if (!fs.existsSync(file)) {
        fs.writeJsonSync(file, {});
    }
});

// Admin secret code
const ADMIN_SECRET = '#6287717274346';
const activeSessions = new Map();
const userSockets = new Map();

// Routes

// Check auth status
app.get('/api/auth/status', (req, res) => {
    res.json({ 
        botReady: isBotReady(),
        timestamp: Date.now()
    });
});

// Request OTP
app.post('/api/auth/otp', async (req, res) => {
    const { phone, email, type } = req.body;
    
    if (!phone && !email) {
        return res.status(400).json({ error: 'Phone or email required' });
    }
    
    const target = phone || email;
    
    // Check if it's admin secret code
    if (target === ADMIN_SECRET) {
        return res.json({ 
            success: true, 
            isAdmin: true,
            message: 'Admin access granted'
        });
    }
    
    // Send OTP via WhatsApp Bot
    if (type === 'phone' && phone) {
        const success = await botAPI.sendOTP(phone);
        if (success) {
            res.json({ success: true, message: 'OTP sent via WhatsApp' });
        } else {
            res.status(500).json({ error: 'Failed to send OTP' });
        }
    } else {
        // For email, generate OTP and send via email service (placeholder)
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        res.json({ success: true, message: 'OTP sent via Email (simulated)' });
    }
});

// Verify OTP
app.post('/api/auth/verify', async (req, res) => {
    const { phone, email, code, adminCode } = req.body;
    
    // Admin login with secret code
    if (adminCode === ADMIN_SECRET) {
        const sessionId = uuidv4();
        const adminData = {
            id: 'admin',
            name: 'Administrator',
            role: 'admin',
            phone: '6287717274346',
            sessionId,
            loginAt: Date.now()
        };
        
        activeSessions.set(sessionId, adminData);
        
        return res.json({
            success: true,
            isAdmin: true,
            sessionId,
            user: adminData
        });
    }
    
    // Regular OTP verification
    const target = phone || email;
    const result = botAPI.verifyOTP(target, code);
    
    if (result.valid) {
        const sessionId = uuidv4();
        const userData = {
            id: uuidv4(),
            name: target,
            phone: phone || null,
            email: email || null,
            role: 'user',
            sessionId,
            loginAt: Date.now(),
            settings: {
                darkMode: false,
                notifications: true,
                sound: true,
                vibration: true
            }
        };
        
        // Save user
        botAPI.registerUser(target, userData);
        activeSessions.set(sessionId, userData);
        
        res.json({
            success: true,
            sessionId,
            user: userData
        });
    } else {
        res.status(400).json({ error: result.message });
    }
});

// Validate session
app.post('/api/auth/validate', (req, res) => {
    const { sessionId } = req.body;
    const session = activeSessions.get(sessionId);
    
    if (session) {
        res.json({ valid: true, user: session });
    } else {
        res.status(401).json({ valid: false });
    }
});

// Admin Routes
app.get('/api/admin/stats', (req, res) => {
    const { sessionId } = req.headers;
    const session = activeSessions.get(sessionId);
    
    if (!session || session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    res.json(botAPI.getStats());
});

// Send message to specific user
app.post('/api/admin/send', async (req, res) => {
    const { sessionId } = req.headers;
    const session = activeSessions.get(sessionId);
    
    if (!session || session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { phone, message, type = 'text' } = req.body;
    
    if (!phone || !message) {
        return res.status(400).json({ error: 'Phone and message required' });
    }
    
    const success = await botAPI.sendNotification(phone, message);
    res.json({ success });
});

// Broadcast to all users
app.post('/api/admin/broadcast', async (req, res) => {
    const { sessionId } = req.headers;
    const session = activeSessions.get(sessionId);
    
    if (!session || session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const { message } = req.body;
    const result = await botAPI.broadcast(message);
    res.json(result);
});

// Get all users
app.get('/api/admin/users', (req, res) => {
    const { sessionId } = req.headers;
    const session = activeSessions.get(sessionId);
    
    if (!session || session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const users = fs.readJsonSync(USERS_FILE);
    res.json(users);
});

// Update bot settings
app.post('/api/admin/settings', (req, res) => {
    const { sessionId } = req.headers;
    const session = activeSessions.get(sessionId);
    
    if (!session || session.role !== 'admin') {
        return res.status(403).json({ error: 'Unauthorized' });
    }
    
    const settings = req.body;
    fs.writeJsonSync(SETTINGS_FILE, settings);
    res.json({ success: true });
});

// User Routes
app.post('/api/user/settings', (req, res) => {
    const { sessionId } = req.body;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.status(401).json({ error: 'Invalid session' });
    }
    
    const { settings } = req.body;
    session.settings = { ...session.settings, ...settings };
    activeSessions.set(sessionId, session);
    
    // Update in users file
    const users = fs.readJsonSync(USERS_FILE);
    const userKey = session.phone || session.email;
    if (users[userKey]) {
        users[userKey].settings = session.settings;
        fs.writeJsonSync(USERS_FILE, users);
    }
    
    res.json({ success: true });
});

// Save notification preferences
app.post('/api/user/notifications', (req, res) => {
    const { sessionId, preferences } = req.body;
    const session = activeSessions.get(sessionId);
    
    if (!session) {
        return res.status(401).json({ error: 'Invalid session' });
    }
    
    const notifications = fs.readJsonSync(NOTIFICATIONS_FILE);
    notifications[session.id] = preferences;
    fs.writeJsonSync(NOTIFICATIONS_FILE, notifications);
    
    res.json({ success: true });
});

// Socket.io Handling
io.on('connection', (socket) => {
    console.log('Client connected:', socket.id);
    
    socket.on('authenticate', (sessionId) => {
        const session = activeSessions.get(sessionId);
        if (session) {
            userSockets.set(sessionId, socket.id);
            socket.sessionId = sessionId;
            socket.join(session.id);
            
            // Update online status
            session.online = true;
            activeSessions.set(sessionId, session);
            
            io.emit('user_online', { userId: session.id });
        }
    });
    
    socket.on('join_chat', (chatId) => {
        socket.join(chatId);
    });
    
    socket.on('send_message', (data) => {
        const { chatId, message, type = 'text' } = data;
        const session = activeSessions.get(socket.sessionId);
        
        if (!session) return;
        
        const msgData = {
            id: uuidv4(),
            sender: session.id,
            senderName: session.name,
            chatId,
            type,
            content: message,
            timestamp: Date.now(),
            status: 'sent'
        };
        
        // Save message
        const messages = fs.readJsonSync(MESSAGES_FILE);
        if (!messages[chatId]) messages[chatId] = [];
        messages[chatId].push(msgData);
        fs.writeJsonSync(MESSAGES_FILE, messages);
        
        // Broadcast to chat room
        io.to(chatId).emit('new_message', msgData);
        
        // Send notification to offline users
        sendPushNotification(chatId, msgData, session);
    });
    
    socket.on('typing', (data) => {
        const { chatId, isTyping } = data;
        socket.to(chatId).emit('typing', {
            userId: socket.sessionId,
            isTyping
        });
    });
    
    socket.on('call_request', (data) => {
        const { targetId, type } = data;
        const targetSocket = Array.from(io.sockets.sockets.values()).find(
            s => s.sessionId && activeSessions.get(s.sessionId)?.id === targetId
        );
        
        if (targetSocket) {
            targetSocket.emit('incoming_call', {
                from: socket.sessionId,
                type
            });
        }
    });
    
    socket.on('call_response', (data) => {
        const { callerId, accepted } = data;
        io.to(callerId).emit('call_answered', { accepted });
    });
    
    socket.on('disconnect', () => {
        if (socket.sessionId) {
            const session = activeSessions.get(socket.sessionId);
            if (session) {
                session.online = false;
                session.lastSeen = Date.now();
                activeSessions.set(socket.sessionId, session);
                userSockets.delete(socket.sessionId);
                
                io.emit('user_offline', { 
                    userId: session.id,
                    lastSeen: session.lastSeen
                });
            }
        }
    });
});

// Push Notification Simulation
async function sendPushNotification(chatId, message, sender) {
    // In real implementation, use Firebase Cloud Messaging or OneSignal
    const notifications = fs.readJsonSync(NOTIFICATIONS_FILE);
    
    // Find users in chat who are offline
    const users = fs.readJsonSync(USERS_FILE);
    
    for (const [phone, user] of Object.entries(users)) {
        const isOnline = Array.from(activeSessions.values()).some(s => 
            s.phone === phone || s.email === user.email
        );
        
        if (!isOnline && notifications[user.id]?.chatNotifications !== false) {
            // Send WhatsApp notification
            await botAPI.sendNotification(phone, 
                `💬 *Pesan Baru dari ${sender.name}*\n\n${message.content}\n\nBuka NdiiClouD Chat untuk membalas.`
            );
        }
    }
}

// Start server
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`🌐 Website: http://localhost:${PORT}`);
    
    // Start WhatsApp Bot
    try {
        await startBot();
    } catch (err) {
        console.error('Bot startup error:', err);
    }
});
