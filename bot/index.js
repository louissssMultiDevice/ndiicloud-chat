/**
 * =====================================================
 * NdiiClouD Chat Pro - Advanced Wileys Bot
 * =====================================================
 * Fitur:
 * - Multi-device support
 * - Auto-reconnect dengan exponential backoff
 * - Message queue system
 * - Media download/upload
 * - Group management
 * - Status (story) viewer
 * - Auto-responder AI
 * - Scheduled messages
 * - Anti-spam protection
 * - Command system lengkap
 * =====================================================
 */

const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    jidDecode,
    delay,
    fetchLatestBaileysVersion,
    makeInMemoryStore,
    proto,
    getContentType,
    downloadContentFromMessage
} = require('wileys');

const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');
const cron = require('node-cron');
const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');

// Logger setup
const logger = pino({ 
    level: 'info',
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore: 'pid,hostname'
        }
    }
});

// Directories
const SESSIONS_DIR = './sessions';
const DATA_DIR = './data';
const MEDIA_DIR = './media';
const TEMP_DIR = './temp';

// Ensure directories exist
[SESSIONS_DIR, DATA_DIR, MEDIA_DIR, TEMP_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// Data files
const FILES = {
    USERS: path.join(DATA_DIR, 'users.json'),
    OTP: path.join(DATA_DIR, 'otp.json'),
    MESSAGES: path.join(DATA_DIR, 'messages.json'),
    SETTINGS: path.join(DATA_DIR, 'settings.json'),
    GROUPS: path.join(DATA_DIR, 'groups.json'),
    QUEUE: path.join(DATA_DIR, 'queue.json'),
    STATS: path.join(DATA_DIR, 'stats.json')
};

// Initialize data files
Object.values(FILES).forEach(file => {
    if (!fs.existsSync(file)) fs.writeJsonSync(file, {});
});

// In-memory store
const store = makeInMemoryStore({ logger });
const msgRetryCounterCache = new Map();
const callOfferCache = new Map();

// Bot state
let ndii = null;
let isBotReady = false;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const RECONNECT_INTERVAL = 5000;

// Readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// =====================================================
// DATABASE HELPERS
// =====================================================

const DB = {
    get: (file) => {
        try {
            return fs.readJsonSync(file);
        } catch {
            return {};
        }
    },
    
    set: (file, data) => {
        fs.writeJsonSync(file, data, { spaces: 2 });
    },
    
    update: (file, key, value) => {
        const data = DB.get(file);
        data[key] = value;
        DB.set(file, data);
    },
    
    delete: (file, key) => {
        const data = DB.get(file);
        delete data[key];
        DB.set(file, data);
    }
};

// =====================================================
// MESSAGE QUEUE SYSTEM
// =====================================================

class MessageQueue {
    constructor() {
        this.queue = [];
        this.processing = false;
        this.load();
    }
    
    load() {
        this.queue = DB.get(FILES.QUEUE).messages || [];
    }
    
    save() {
        DB.set(FILES.QUEUE, { messages: this.queue });
    }
    
    add(message) {
        this.queue.push({
            id: uuidv4(),
            ...message,
            addedAt: Date.now(),
            attempts: 0
        });
        this.save();
        this.process();
    }
    
    async process() {
        if (this.processing || this.queue.length === 0 || !isBotReady) return;
        
        this.processing = true;
        const msg = this.queue[0];
        
        try {
            await this.send(msg);
            this.queue.shift();
            this.save();
            logger.info(`✅ Message sent: ${msg.id}`);
        } catch (err) {
            msg.attempts++;
            if (msg.attempts >= 3) {
                logger.error(`❌ Message failed after 3 attempts: ${msg.id}`);
                this.queue.shift();
            } else {
                logger.warn(`⚠️ Message retry ${msg.attempts}: ${msg.id}`);
            }
            this.save();
            await delay(2000);
        }
        
        this.processing = false;
        if (this.queue.length > 0) {
            setTimeout(() => this.process(), 1000);
        }
    }
    
    async send(msg) {
        const jid = msg.to.includes('@') ? msg.to : `${msg.to}@s.whatsapp.net`;
        
        switch (msg.type) {
            case 'text':
                await ndii.sendMessage(jid, { text: msg.content });
                break;
            case 'image':
                await ndii.sendMessage(jid, { 
                    image: fs.readFileSync(msg.mediaPath),
                    caption: msg.caption 
                });
                break;
            case 'video':
                await ndii.sendMessage(jid, { 
                    video: fs.readFileSync(msg.mediaPath),
                    caption: msg.caption 
                });
                break;
            case 'audio':
                await ndii.sendMessage(jid, { 
                    audio: fs.readFileSync(msg.mediaPath),
                    mimetype: 'audio/mp4',
                    ptt: msg.ptt || false
                });
                break;
            case 'document':
                await ndii.sendMessage(jid, { 
                    document: fs.readFileSync(msg.mediaPath),
                    fileName: msg.fileName,
                    mimetype: msg.mimetype
                });
                break;
            case 'location':
                await ndii.sendMessage(jid, { 
                    location: msg.location 
                });
                break;
            case 'button':
                await ndii.sendMessage(jid, {
                    buttons: msg.buttons,
                    text: msg.content,
                    footer: msg.footer,
                    headerType: 1
                });
                break;
            case 'template':
                await ndii.sendMessage(jid, {
                    templateButtons: msg.templateButtons,
                    text: msg.content,
                    footer: msg.footer
                });
                break;
            default:
                await ndii.sendMessage(jid, { text: msg.content });
        }
    }
}

const messageQueue = new MessageQueue();

// =====================================================
// ANTI-SPAM SYSTEM
// =====================================================

class AntiSpam {
    constructor() {
        this.messages = new Map();
        this.banned = new Set();
        this.limits = {
            messages: 10,      // max messages
            window: 10000,     // per 10 seconds
            blockDuration: 300000 // 5 minutes block
        };
    }
    
    check(userId) {
        if (this.banned.has(userId)) {
            const remaining = this.getRemainingBlock(userId);
            if (remaining > 0) return { allowed: false, reason: 'banned', remaining };
            this.banned.delete(userId);
        }
        
        const now = Date.now();
        const userMessages = this.messages.get(userId) || [];
        
        // Clean old messages
        const recent = userMessages.filter(time => now - time < this.limits.window);
        recent.push(now);
        this.messages.set(userId, recent);
        
        if (recent.length > this.limits.messages) {
            this.ban(userId);
            return { allowed: false, reason: 'spam_detected', blockDuration: this.limits.blockDuration };
        }
        
        return { allowed: true };
    }
    
    ban(userId) {
        this.banned.add(userId);
        setTimeout(() => this.banned.delete(userId), this.limits.blockDuration);
        logger.warn(`🚫 User banned for spam: ${userId}`);
    }
    
    getRemainingBlock(userId) {
        // Simplified - in real implementation, track ban time
        return this.limits.blockDuration;
    }
}

const antiSpam = new AntiSpam();

// =====================================================
// AUTO-RESPONDER AI
// =====================================================

class AutoResponder {
    constructor() {
        this.responses = DB.get(FILES.SETTINGS).autoResponses || {
            greetings: ['halo', 'hai', 'hi', 'hello', 'hey'],
            goodbyes: ['dadah', 'bye', 'selamat tinggal', 'sampai jumpa'],
            thanks: ['terima kasih', 'thanks', 'makasih', 'thank you'],
            help: ['bantuan', 'help', 'tolong', 'cara']
        };
        
        this.replies = {
            greetings: [
                '👋 Halo! Ada yang bisa saya bantu?',
                'Hai! Selamat datang di NdiiClouD! 🌩️',
                'Hello! How can I assist you today?'
            ],
            goodbyes: [
                '👋 Sampai jumpa! Jangan lupa mampir lagi ya!',
                'Dadah! Hati-hati di jalan! 🚗',
                'Bye bye! Have a great day! ✨'
            ],
            thanks: [
                'Sama-sama! 😊',
                'Terima kasih kembali! 🙏',
                'No problem! Senang bisa membantu!'
            ],
            help: [
                '🆘 *Bantuan NdiiClouD*\n\nKetik:\n• *login* - Cara login\n• *fitur* - Lihat fitur\n• *admin* - Hubungi admin\n• *otp* - Masalah OTP',
                'Butuh bantuan? Silakan hubungi admin di menu pengaturan!'
            ]
        };
    }
    
    async process(sender, text) {
        const lower = text.toLowerCase();
        const settings = DB.get(FILES.SETTINGS);
        
        if (!settings.autoReplyEnabled) return false;
        
        for (const [category, keywords] of Object.entries(this.responses)) {
            if (keywords.some(k => lower.includes(k))) {
                const replies = this.replies[category];
                const reply = replies[Math.floor(Math.random() * replies.length)];
                
                await delay(1000 + Math.random() * 2000); // Natural delay
                await sendMessage(sender, reply);
                return true;
            }
        }
        
        // Default response for questions
        if (lower.includes('?') || lower.startsWith('apa') || lower.startsWith('bagaimana') || lower.startsWith('mengapa')) {
            const defaults = [
                'Maaf, saya belum mengerti. Ketik *bantuan* untuk melihat menu.',
                'Hmm, pertanyaan menarik! Hubungi admin untuk info lebih lanjut.',
                'Saya masih belajar. Coba ketik perintah yang tersedia ya! 😊'
            ];
            await delay(1500);
            await sendMessage(sender, defaults[Math.floor(Math.random() * defaults.length)]);
            return true;
        }
        
        return false;
    }
}

const autoResponder = new AutoResponder();

// =====================================================
// MAIN BOT INITIALIZATION
// =====================================================

async function startBot() {
    try {
        logger.info('🚀 Starting NdiiClouD Bot...');
        
        const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
        const { version, isLatest } = await fetchLatestBaileysVersion();
        
        logger.info(`📦 Using WA v${version.join('.')}, isLatest: ${isLatest}`);
        
        ndii = makeWASocket({
            version,
            logger: pino({ level: 'silent' }),
            printQRInTerminal: true,
            auth: {
                creds: state.creds,
                keys: state.keys
            },
            browser: ['NdiiClouD Pro', 'Chrome', '20.0.0'],
            msgRetryCounterCache,
            generateHighQualityLinkPreview: true,
            syncFullHistory: true,
            markOnlineOnConnect: true,
            keepAliveIntervalMs: 30000,
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 60000,
            retryRequestDelayMs: 250,
            maxMsgRetryCount: 5,
            fireInitQueries: true,
            shouldIgnoreJid: jid => {
                const isGroup = jid.endsWith('@g.us');
                const isBroadcast = jid === 'status@broadcast';
                return isBroadcast; // Ignore status broadcast for processing
            },
            getMessage: async (key) => {
                const msg = await store.loadMessage(key.remoteJid, key.id);
                return msg?.message || undefined;
            }
        });
        
        // Bind store
        store.bind(ndii.ev);
        
        // Connection Handler
        ndii.ev.on('connection.update', handleConnectionUpdate);
        
        // Credentials Update
        ndii.ev.on('creds.update', saveCreds);
        
        // Messages Handler
        ndii.ev.on('messages.upsert', handleMessages);
        
        // Group Participants Update
        ndii.ev.on('group-participants.update', handleGroupUpdate);
        
        // Presence Update
        ndii.ev.on('presence.update', handlePresenceUpdate);
        
        // Calls Handler
        ndii.ev.on('call', handleCall);
        
        // Status Handler
        ndii.ev.on('status.update', handleStatusUpdate);
        
        logger.info('✅ Bot initialized successfully');
        
    } catch (err) {
        logger.error('❌ Failed to start bot:', err);
        handleReconnect();
    }
}

async function handleConnectionUpdate(update) {
    const { connection, lastDisconnect, qr, receivedPendingNotifications } = update;
    
    if (qr) {
        logger.info('📱 QR Code received, please scan!');
        reconnectAttempts = 0;
    }
    
    if (connection === 'connecting') {
        logger.info('🔄 Connecting to WhatsApp...');
    }
    
    if (connection === 'open') {
        logger.info('✅ Bot connected successfully!');
        isBotReady = true;
        reconnectAttempts = 0;
        
        // Update stats
        const stats = DB.get(FILES.STATS);
        stats.lastConnected = Date.now();
        stats.connectionCount = (stats.connectionCount || 0) + 1;
        DB.set(FILES.STATS, stats);
        
        // Send startup notification
        const settings = DB.get(FILES.SETTINGS);
        if (settings.adminNumber) {
            await sendMessage(settings.adminNumber, 
                `🤖 *NdiiClouD Bot Online!*\n\n` +
                `⏰ ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}\n` +
                `📊 Connection #${stats.connectionCount}\n` +
                `🌩️ Ready to serve!`
            );
        }
        
        // Start scheduled tasks
        startScheduledTasks();
        
        // Process pending queue
        messageQueue.process();
    }
    
    if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        
        logger.error(`❌ Connection closed: ${statusCode} - ${DisconnectReason[statusCode] || 'Unknown'}`);
        
        isBotReady = false;
        
        if (shouldReconnect) {
            handleReconnect();
        } else {
            logger.error('🔒 Logged out, please scan QR again');
            // Clear sessions if needed
            // fs.removeSync(SESSIONS_DIR);
        }
    }
    
    if (receivedPendingNotifications) {
        logger.info('📬 Received pending notifications');
    }
}

function handleReconnect() {
    reconnectAttempts++;
    
    if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        logger.error(`❌ Max reconnection attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
        logger.info('🔄 Restarting bot in 30 seconds...');
        setTimeout(startBot, 30000);
        return;
    }
    
    const delay = Math.min(RECONNECT_INTERVAL * Math.pow(2, reconnectAttempts - 1), 60000);
    logger.info(`🔄 Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    
    setTimeout(startBot, delay);
}

// =====================================================
// MESSAGE HANDLER
// =====================================================

async function handleMessages(m) {
    if (m.type !== 'notify') return;
    
    for (const msg of m.messages) {
        try {
            if (!msg.message || msg.key.fromMe) continue;
            
            const sender = ndii.decodeJid(msg.key.remoteJid);
            const messageType = getContentType(msg.message);
            const messageContent = extractMessageContent(msg);
            const isGroup = sender.endsWith('@g.us');
            const senderName = msg.pushName || 'Unknown';
            
            // Anti-spam check
            const spamCheck = antiSpam.check(sender);
            if (!spamCheck.allowed) {
                if (spamCheck.reason === 'spam_detected') {
                    await sendMessage(sender, `⚠️ *Spam Terdeteksi!*\n\nAnda terblokir selama 5 menit.`);
                }
                continue;
            }
            
            // Log message
            logger.info(`📨 ${isGroup ? '[GROUP] ' : ''}${senderName}: ${messageContent.text?.substring(0, 50) || '[MEDIA]'}`);
            
            // Save to database
            saveMessage(sender, msg);
            
            // Update user activity
            updateUserActivity(sender, senderName);
            
            // Process commands
            if (messageContent.text?.startsWith('/')) {
                await processCommand(sender, messageContent.text, msg, isGroup);
                continue;
            }
            
            // Auto-responder for DMs
            if (!isGroup) {
                const responded = await autoResponder.process(sender, messageContent.text);
                if (responded) continue;
            }
            
            // Group specific handling
            if (isGroup) {
                await handleGroupMessage(sender, msg, messageContent);
            }
            
        } catch (err) {
            logger.error('Error handling message:', err);
        }
    }
}

function extractMessageContent(msg) {
    const type = getContentType(msg.message);
    const content = {};
    
    switch (type) {
        case 'conversation':
            content.text = msg.message.conversation;
            break;
        case 'extendedTextMessage':
            content.text = msg.message.extendedTextMessage.text;
            content.contextInfo = msg.message.extendedTextMessage.contextInfo;
            break;
        case 'imageMessage':
            content.text = msg.message.imageMessage.caption;
            content.media = msg.message.imageMessage;
            content.mimetype = msg.message.imageMessage.mimetype;
            break;
        case 'videoMessage':
            content.text = msg.message.videoMessage.caption;
            content.media = msg.message.videoMessage;
            content.mimetype = msg.message.videoMessage.mimetype;
            break;
        case 'audioMessage':
            content.media = msg.message.audioMessage;
            content.mimetype = msg.message.audioMessage.mimetype;
            content.ptt = msg.message.audioMessage.ptt;
            break;
        case 'documentMessage':
            content.text = msg.message.documentMessage.caption;
            content.media = msg.message.documentMessage;
            content.fileName = msg.message.documentMessage.fileName;
            content.mimetype = msg.message.documentMessage.mimetype;
            break;
        case 'locationMessage':
            content.location = {
                degreesLatitude: msg.message.locationMessage.degreesLatitude,
                degreesLongitude: msg.message.locationMessage.degreesLongitude,
                name: msg.message.locationMessage.name
            };
            break;
        case 'contactMessage':
            content.contact = msg.message.contactMessage;
            break;
        case 'stickerMessage':
            content.media = msg.message.stickerMessage;
            content.isSticker = true;
            break;
        default:
            content.text = '[Unsupported message type]';
    }
    
    return content;
}

// =====================================================
// COMMAND PROCESSOR
// =====================================================

async function processCommand(sender, text, msg, isGroup) {
    const args = text.slice(1).trim().split(/ +/);
    const command = args.shift().toLowerCase();
    const settings = DB.get(FILES.SETTINGS);
    const isAdmin = sender === `${settings.adminNumber}@s.whatsapp.net`;
    
    // User commands
    switch (command) {
        case 'menu':
        case 'help':
            return sendMenu(sender);
            
        case 'ping':
            return sendMessage(sender, `🏓 Pong!\n⏱️ Latency: ${Date.now() - msg.messageTimestamp * 1000}ms`);
            
        case 'info':
        case 'status':
            return sendBotInfo(sender);
            
        case 'waktu':
        case 'time':
            return sendMessage(sender, `🕐 ${moment().tz('Asia/Jakarta').format('dddd, DD MMMM YYYY HH:mm:ss')}`);
            
        case 'owner':
        case 'creator':
            return sendMessage(sender, `🌩️ *NdiiClouD*\n\nDibuat oleh: NdiiClouD Team\nVersion: 3.0.0\nWebsite: ndiicloud.com`);
    }
    
    // Admin only commands
    if (!isAdmin) {
        return sendMessage(sender, '❌ Anda tidak memiliki akses untuk perintah ini.');
    }
    
    switch (command) {
        case 'broadcast':
        case 'bc':
            return cmdBroadcast(args.join(' '));
            
        case 'stats':
            return cmdStats(sender);
            
        case 'otp':
            if (args.length >= 2) {
                return cmdSendOTP(args[0], args[1]);
            }
            return sendMessage(sender, '❌ Format: /otp [nomor] [kode]');
            
        case 'notify':
            if (args.length >= 2) {
                const phone = args.shift();
                return cmdNotify(phone, args.join(' '));
            }
            return sendMessage(sender, '❌ Format: /notify [nomor] [pesan]');
            
        case 'getgroups':
            return cmdGetGroups(sender);
            
        case 'joingroup':
            if (args[0]) {
                return cmdJoinGroup(args[0]);
            }
            return sendMessage(sender, '❌ Format: /joingroup [link]');
            
        case 'leave':
            if (args[0]) {
                return cmdLeaveGroup(args[0]);
            }
            return sendMessage(sender, '❌ Format: /leave [groupId]');
            
        case 'setpp':
            return cmdSetProfilePicture(msg);
            
        case 'block':
            if (args[0]) {
                await ndii.updateBlockStatus(`${args[0]}@s.whatsapp.net`, 'block');
                return sendMessage(sender, `✅ Blocked ${args[0]}`);
            }
            break;
            
        case 'unblock':
            if (args[0]) {
                await ndii.updateBlockStatus(`${args[0]}@s.whatsapp.net`, 'unblock');
                return sendMessage(sender, `✅ Unblocked ${args[0]}`);
            }
            break;
            
        case 'clearchat':
            if (args[0]) {
                await ndii.chatModify({ delete: true, lastMessages: [] }, `${args[0]}@s.whatsapp.net`);
                return sendMessage(sender, `✅ Cleared chat with ${args[0]}`);
            }
            break;
            
        case 'archive':
            if (args[0]) {
                await ndii.chatModify({ archive: true }, `${args[0]}@s.whatsapp.net`);
                return sendMessage(sender, `✅ Archived chat ${args[0]}`);
            }
            break;
            
        case 'unarchive':
            if (args[0]) {
                await ndii.chatModify({ archive: false }, `${args[0]}@s.whatsapp.net`);
                return sendMessage(sender, `✅ Unarchived chat ${args[0]}`);
            }
            break;
            
        case 'mute':
            if (args.length >= 2) {
                const duration = parseInt(args[1]) * 24 * 60 * 60 * 1000; // days to ms
                await ndii.chatModify({ mute: duration }, `${args[0]}@s.whatsapp.net`);
                return sendMessage(sender, `🔇 Muted ${args[0]} for ${args[1]} days`);
            }
            break;
            
        case 'unmute':
            if (args[0]) {
                await ndii.chatModify({ mute: null }, `${args[0]}@s.whatsapp.net`);
                return sendMessage(sender, `🔊 Unmuted ${args[0]}`);
            }
            break;
            
        case 'pin':
            if (args[0]) {
                await ndii.chatModify({ pin: true }, `${args[0]}@s.whatsapp.net`);
                return sendMessage(sender, `📌 Pinned chat ${args[0]}`);
            }
            break;
            
        case 'unpin':
            if (args[0]) {
                await ndii.chatModify({ pin: false }, `${args[0]}@s.whatsapp.net`);
                return sendMessage(sender, `📍 Unpinned chat ${args[0]}`);
            }
            break;
            
        case 'delete':
            if (args[0] && msg.message.extendedTextMessage?.contextInfo?.stanzaId) {
                await ndii.sendMessage(sender, { delete: {
                    remoteJid: sender,
                    fromMe: false,
                    id: msg.message.extendedTextMessage.contextInfo.stanzaId,
                    participant: args[0]
                }});
                return sendMessage(sender, '✅ Message deleted');
            }
            break;
            
        case 'react':
            if (args[0] && msg.message.extendedTextMessage?.contextInfo?.stanzaId) {
                await ndii.sendMessage(sender, {
                    react: {
                        text: args[0],
                        key: {
                            remoteJid: sender,
                            id: msg.message.extendedTextMessage.contextInfo.stanzaId
                        }
                    }
                });
                return;
            }
            break;
            
        case 'getstory':
        case 'getstatus':
            return cmdGetStatus(sender, args[0]);
            
        case 'sendstory':
        case 'sendstatus':
            return cmdSendStatus(sender, args.join(' '));
            
        case 'save':
            return cmdSaveContact(msg);
            
        case 'getcontact':
            if (args[0]) {
                return cmdGetContact(sender, args[0]);
            }
            break;
            
        case 'setname':
            if (args.join(' ')) {
                await ndii.updateProfileName(args.join(' '));
                return sendMessage(sender, `✅ Name updated to: ${args.join(' ')}`);
            }
            break;
            
        case 'setstatus':
            if (args.join(' ')) {
                await ndii.updateProfileStatus(args.join(' '));
                return sendMessage(sender, `✅ Status updated`);
            }
            break;
            
        case 'setppbot':
            return cmdSetBotPP(msg);
            
        case 'restart':
            await sendMessage(sender, '🔄 Restarting bot...');
            process.exit(0);
            break;
            
        case 'shutdown':
            await sendMessage(sender, '👋 Shutting down...');
            process.exit(1);
            break;
            
        default:
            sendMessage(sender, '❓ Perintah tidak dikenal. Ketik /menu untuk melihat daftar.');
    }
}

// =====================================================
// COMMAND IMPLEMENTATIONS
// =====================================================

async function sendMenu(to) {
    const menu = `🤖 *NdiiClouD Bot Menu*

*📱 User Commands:*
• /menu - Tampilkan menu ini
• /ping - Cek latency
• /info - Info bot
• /waktu - Waktu sekarang
• /owner - Info pembuat

*👑 Admin Commands:*
• /broadcast [pesan] - Kirim ke semua
• /stats - Statistik bot
• /otp [nomor] [kode] - Kirim OTP
• /notify [nomor] [pesan] - Notifikasi
• /getgroups - Daftar grup
• /joingroup [link] - Join grup
• /leave [id] - Keluar grup
• /block [nomor] - Blokir user
• /unblock [nomor] - Buka blokir
• /clearchat [nomor] - Hapus chat
• /archive [nomor] - Arsipkan
• /unarchive [nomor] - Buka arsip
• /mute [nomor] [hari] - Bisukan
• /unmute [nomor] - Buka bisu
• /pin [nomor] - Sematkan
• /unpin [nomor] - Lepas semat
• /getstatus [nomor] - Lihat status
• /sendstatus [teks] - Kirim status
• /setname [nama] - Ubah nama bot
• /setstatus [teks] - Ubah status bot
• /restart - Restart bot
• /shutdown - Matikan bot

🌩️ *NdiiClouD v3.0*`;
    
    await sendMessage(to, menu);
}

async function sendBotInfo(to) {
    const stats = DB.get(FILES.STATS);
    const users = DB.get(FILES.USERS);
    
    const info = `🤖 *NdiiClouD Bot Info*

📦 Version: 3.0.0 Pro
📚 Library: Wileys
⏱️ Uptime: ${formatUptime(process.uptime())}
👥 Total Users: ${Object.keys(users).length}
📨 Messages Handled: ${stats.messagesHandled || 0}
🔁 Reconnections: ${stats.connectionCount || 0}
🕐 Last Connected: ${stats.lastConnected ? moment(stats.lastConnected).fromNow() : 'Never'}

🌩️ *Powered by NdiiClouD*`;
    
    await sendMessage(to, info);
}

async function cmdBroadcast(text) {
    if (!text) return;
    
    const users = DB.get(FILES.USERS);
    const message = `📢 *PENGUMUMAN NdiiClouD*\n\n${text}\n\n🌩️ *Tim NdiiClouD*`;
    
    let success = 0;
    let failed = 0;
    
    for (const [number, user] of Object.entries(users)) {
        try {
            await sendMessage(`${number}@s.whatsapp.net`, message);
            success++;
            await delay(1000);
        } catch {
            failed++;
        }
    }
    
    logger.info(`Broadcast: ${success} success, ${failed} failed`);
}

async function cmdStats(to) {
    const users = DB.get(FILES.USERS);
    const stats = DB.get(FILES.STATS);
    const queue = messageQueue.queue.length;
    
    const statsMsg = `📊 *NdiiClouD Statistics*

👥 Total Users: ${Object.keys(users).length}
📨 Messages: ${stats.messagesHandled || 0}
📤 Sent: ${stats.messagesSent || 0}
📥 Received: ${stats.messagesReceived || 0}
⏳ Queue: ${queue} messages
🔁 Connections: ${stats.connectionCount || 0}
⚡ Uptime: ${formatUptime(process.uptime())}

🌩️ *Real-time Stats*`;
    
    await sendMessage(to, statsMsg);
}

async function cmdSendOTP(phone, code) {
    const formatted = phone.replace(/[^0-9]/g, '');
    const message = `🔐 *KODE OTP NdiiClouD*\n\nKode: *${code}*\n\n⏰ Berlaku 5 menit\n🔒 Jangan bagikan!\n\n🌩️ NdiiClouD Security`;
    
    await sendMessage(`${formatted}@s.whatsapp.net`, message);
    
    // Save to DB
    DB.update(FILES.OTP, formatted, {
        code,
        expires: Date.now() + (5 * 60 * 1000),
        attempts: 0
    });
}

async function cmdNotify(phone, message) {
    const formatted = phone.replace(/[^0-9]/g, '');
    await sendMessage(`${formatted}@s.whatsapp.net`, 
        `🔔 *Notifikasi NdiiClouD*\n\n${message}\n\n🌩️ NdiiClouD`);
}

async function cmdGetGroups(to) {
    const groups = await ndii.groupFetchAllParticipating();
    let text = `👥 *Daftar Grup (${Object.keys(groups).length})*\n\n`;
    
    for (const [id, group] of Object.entries(groups)) {
        text += `📌 *${group.subject}*\n`;
        text += `ID: ${id}\n`;
        text += `Members: ${group.participants.length}\n`;
        text += `Created: ${moment(group.creation * 1000).format('DD/MM/YYYY')}\n\n`;
    }
    
    await sendMessage(to, text);
}

async function cmdJoinGroup(link) {
    const code = link.split('https://chat.whatsapp.com/')[1];
    if (code) {
        const response = await ndii.groupAcceptInvite(code);
        logger.info('Joined group:', response);
    }
}

async function cmdLeaveGroup(groupId) {
    await ndii.groupLeave(groupId);
    logger.info('Left group:', groupId);
}

async function cmdGetStatus(to, number) {
    if (!number) {
        // Get all status
        const status = await ndii.fetchStatusUpdates();
        let text = `📱 *Status Updates*\n\n`;
        for (const [jid, updates] of Object.entries(status)) {
            text += `${jid}: ${updates.length} updates\n`;
        }
        return sendMessage(to, text);
    }
    
    const jid = `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    const status = await ndii.fetchStatusUpdates(jid);
    await sendMessage(to, `📱 Status for ${number}:\n${JSON.stringify(status, null, 2)}`);
}

async function cmdSendStatus(to, text) {
    await ndii.sendMessage('status@broadcast', { text });
    await sendMessage(to, '✅ Status sent!');
}

async function cmdSetProfilePicture(msg) {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted?.imageMessage) {
        const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        await ndii.updateProfilePicture(msg.key.remoteJid, buffer);
    }
}

async function cmdSaveContact(msg) {
    const vcard = msg.message.extendedTextMessage?.contextInfo?.quotedMessage?.contactMessage;
    if (vcard) {
        // Save contact logic
        logger.info('Saving contact:', vcard);
    }
}

async function cmdGetContact(to, number) {
    const jid = `${number.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    const info = await ndii.onWhatsApp(jid);
    await sendMessage(to, `📱 Info:\n${JSON.stringify(info, null, 2)}`);
}

async function cmdSetBotPP(msg) {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (quoted?.imageMessage) {
        const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
        let buffer = Buffer.from([]);
        for await (const chunk of stream) {
            buffer = Buffer.concat([buffer, chunk]);
        }
        await ndii.updateProfilePicture(ndii.user.id, buffer);
        await sendMessage(msg.key.remoteJid, '✅ Profile picture updated!');
    }
}

// =====================================================
// HELPER FUNCTIONS
// =====================================================

async function sendMessage(to, text, options = {}) {
    if (!isBotReady) {
        // Queue message if bot not ready
        messageQueue.add({
            to,
            type: 'text',
            content: text,
            ...options
        });
        return false;
    }
    
    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        const result = await ndii.sendMessage(jid, { text, ...options });
        
        // Update stats
        const stats = DB.get(FILES.STATS);
        stats.messagesSent = (stats.messagesSent || 0) + 1;
        DB.set(FILES.STATS, stats);
        
        return result;
    } catch (err) {
        logger.error('Send message error:', err);
        // Queue for retry
        messageQueue.add({
            to,
            type: 'text',
            content: text,
            ...options
        });
        return false;
    }
}

function saveMessage(sender, msg) {
    const messages = DB.get(FILES.MESSAGES);
    const chatId = sender;
    
    if (!messages[chatId]) messages[chatId] = [];
    
    messages[chatId].push({
        id: msg.key.id,
        from: sender,
        content: extractMessageContent(msg),
        timestamp: msg.messageTimestamp,
        type: getContentType(msg.message)
    });
    
    // Keep only last 1000 messages per chat
    if (messages[chatId].length > 1000) {
        messages[chatId] = messages[chatId].slice(-1000);
    }
    
    DB.set(FILES.MESSAGES, messages);
    
    // Update stats
    const stats = DB.get(FILES.STATS);
    stats.messagesHandled = (stats.messagesHandled || 0) + 1;
    stats.messagesReceived = (stats.messagesReceived || 0) + 1;
    DB.set(FILES.STATS, stats);
}

function updateUserActivity(phone, name) {
    const users = DB.get(FILES.USERS);
    const key = phone.replace(/[^0-9]/g, '');
    
    if (!users[key]) {
        users[key] = {
            id: uuidv4(),
            name: name || key,
            firstSeen: Date.now()
        };
    }
    
    users[key].lastActive = Date.now();
    users[key].messageCount = (users[key].messageCount || 0) + 1;
    
    DB.set(FILES.USERS, users);
}

function formatUptime(seconds) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    
    if (days > 0) return `${days}d ${hours}h ${minutes}m`;
    if (hours > 0) return `${hours}h ${minutes}m ${secs}s`;
    return `${minutes}m ${secs}s`;
}

// =====================================================
// GROUP HANDLERS
// =====================================================

async function handleGroupUpdate(update) {
    const { id, participants, action } = update;
    const groupMetadata = await ndii.groupMetadata(id);
    
    logger.info(`👥 Group ${action}: ${participants.join(', ')} in ${groupMetadata.subject}`);
    
    // Welcome message for new members
    if (action === 'add') {
        for (const participant of participants) {
            if (participant === ndii.user.id) continue;
            
            const welcomeMsg = `👋 Selamat datang @${participant.split('@')[0]}!\n\n` +
                             `📌 *${groupMetadata.subject}*\n` +
                             `👥 Member ke-${groupMetadata.participants.length}\n\n` +
                             `Ketik /menu untuk bantuan.`;
            
            await delay(1000);
            await sendMessage(id, welcomeMsg, { mentions: [participant] });
        }
    }
    
    // Goodbye message
    if (action === 'remove') {
        for (const participant of participants) {
            const goodbyeMsg = `👋 Sampai jumpa @${participant.split('@')[0]}!`;
            await sendMessage(id, goodbyeMsg, { mentions: [participant] });
        }
    }
}

async function handleGroupMessage(sender, msg, content) {
    // Group-specific features
    const groupId = sender;
    
    // Auto-delete spam in groups
    if (content.text && content.text.length > 1000) {
        // Potential spam
        logger.warn(`Potential spam in group ${groupId}`);
    }
}

// =====================================================
// PRESENCE & CALL HANDLERS
// =====================================================

async function handlePresenceUpdate(update) {
    const { id, presences } = update;
    logger.debug(`Presence update: ${id}`, presences);
}

async function handleCall(call) {
    logger.info(`📞 Call from ${call.from}`, call);
    
    // Reject call with message
    if (call.status === 'offer') {
        await ndii.sendMessage(call.from, {
            text: '⚠️ Maaf, saya tidak bisa menerima panggilan.\nSilakan kirim pesan teks saja.\n\n🌩️ NdiiClouD Bot'
        });
        
        // Reject the call
        await ndii.rejectCall(call.id, call.from);
    }
}

async function handleStatusUpdate(status) {
    logger.info('Status update:', status);
}

// =====================================================
// SCHEDULED TASKS
// =====================================================

function startScheduledTasks() {
    // Daily stats report to admin
    cron.schedule('0 9 * * *', async () => {
        const settings = DB.get(FILES.SETTINGS);
        if (!settings.adminNumber) return;
        
        const users = DB.get(FILES.USERS);
        const stats = DB.get(FILES.STATS);
        
        const report = `📊 *Daily Report*\n\n` +
                      `📅 ${moment().format('dddd, DD MMMM YYYY')}\n` +
                      `👥 Total Users: ${Object.keys(users).length}\n` +
                      `📨 Messages Today: ${stats.messagesReceived || 0}\n` +
                      `📤 Sent: ${stats.messagesSent || 0}\n` +
                      `⏱️ Uptime: ${formatUptime(process.uptime())}\n\n` +
                      `🌩️ NdiiClouD Systems`;
        
        await sendMessage(settings.adminNumber, report);
    });
    
    // Reminder for inactive users (every 3 days)
    cron.schedule('0 10 */3 * *', async () => {
        const users = DB.get(FILES.USERS);
        const now = Date.now();
        const threeDays = 3 * 24 * 60 * 60 * 1000;
        
        for (const [number, user] of Object.entries(users)) {
            if (now - user.lastActive > threeDays) {
                const reminder = `👋 *Halo ${user.name}!*\n\n` +
                               `Kami rindu Anda! Sudah lama tidak aktif di NdiiClouD.\n` +
                               `Yuk, mampir lagi dan chat dengan teman-teman! 🌩️`;
                
                await sendMessage(number, reminder);
                await delay(2000);
            }
        }
    });
    
    // Clean old messages (weekly)
    cron.schedule('0 0 * * 0', () => {
        const messages = DB.get(FILES.MESSAGES);
        const oneWeekAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        
        for (const [chatId, msgs] of Object.entries(messages)) {
            messages[chatId] = msgs.filter(m => m.timestamp * 1000 > oneWeekAgo);
        }
        
        DB.set(FILES.MESSAGES, messages);
        logger.info('🧹 Cleaned old messages');
    });
    
    // Health check every 5 minutes
    cron.schedule('*/5 * * * *', () => {
        logger.info(`💓 Health check | Uptime: ${formatUptime(process.uptime())} | Queue: ${messageQueue.queue.length}`);
    });
    
    logger.info('⏰ Scheduled tasks started');
}

// =====================================================
// API EXPORT FOR SERVER.JS
// =====================================================

const botAPI = {
    sendOTP: async (phone) => {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await cmdSendOTP(phone, code);
        return true;
    },
    
    verifyOTP: (phone, code) => {
        const otps = DB.get(FILES.OTP);
        const data = otps[phone.replace(/[^0-9]/g, '')];
        
        if (!data) return { valid: false, message: 'OTP tidak ditemukan' };
        if (data.expires < Date.now()) return { valid: false, message: 'OTP expired' };
        if (data.code !== code) {
            data.attempts++;
            DB.set(FILES.OTP, otps);
            return { valid: false, message: 'Kode salah' };
        }
        
        delete otps[phone];
        DB.set(FILES.OTP, otps);
        return { valid: true };
    },
    
    sendNotification: async (phone, message) => {
        return await sendMessage(phone, message);
    },
    
    broadcast: cmdBroadcast,
    
    getStats: () => {
        const users = DB.get(FILES.USERS);
        const stats = DB.get(FILES.STATS);
        return {
            totalUsers: Object.keys(users).length,
            onlineUsers: 0, // Would need tracking
            botStatus: isBotReady ? 'online' : 'offline',
            uptime: process.uptime(),
            messagesHandled: stats.messagesHandled || 0,
            queueLength: messageQueue.queue.length
        };
    },
    
    getUsers: () => DB.get(FILES.USERS),
    
    registerUser: (phone, data) => {
        DB.update(FILES.USERS, phone.replace(/[^0-9]/g, ''), {
            ...data,
            registeredAt: Date.now()
        });
    },
    
    updateUserActivity,
    
    isReady: () => isBotReady,
    
    getQueueStatus: () => ({
        length: messageQueue.queue.length,
        processing: messageQueue.processing
    }),
    
    // Advanced features
    sendMedia: async (phone, type, path, caption) => {
        messageQueue.add({
            to: phone,
            type,
            mediaPath: path,
            caption
        });
    },
    
    getGroups: async () => {
        if (!isBotReady) return [];
        return await ndii.groupFetchAllParticipating();
    },
    
    joinGroup: cmdJoinGroup,
    
    leaveGroup: cmdLeaveGroup
};

// =====================================================
// START BOT
// =====================================================

// Handle graceful shutdown
process.on('SIGINT', async () => {
    logger.info('👋 Shutting down gracefully...');
    if (ndii) {
        await ndii.sendPresenceUpdate('unavailable');
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    logger.info('👋 SIGTERM received, shutting down...');
    process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception:', err);
    // Don't exit, let PM2 handle restart
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start
startBot();

// Export
module.exports = { botAPI, startBot, isBotReady: () => isBotReady };
