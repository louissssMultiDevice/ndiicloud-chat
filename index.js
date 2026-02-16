const { 
    default: makeWASocket, 
    DisconnectReason, 
    useMultiFileAuthState,
    jidDecode,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs-extra');
const path = require('path');
const readline = require('readline');
const cron = require('node-cron');
const moment = require('moment-timezone');
const { v4: uuidv4 } = require('uuid');

// Sessions folder
const SESSIONS_DIR = './sessions';
if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

// Data storage
const USERS_FILE = './data/users.json';
const OTP_FILE = './data/otp.json';
const SETTINGS_FILE = './data/settings.json';
const NOTIFICATIONS_FILE = './data/notifications.json';

// Ensure data directory exists
if (!fs.existsSync('./data')) {
    fs.mkdirSync('./data');
}

// Initialize files
[USERS_FILE, OTP_FILE, SETTINGS_FILE, NOTIFICATIONS_FILE].forEach(file => {
    if (!fs.existsSync(file)) {
        fs.writeJsonSync(file, {});
    }
});

// Readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// OTP Storage
const otpStore = new Map();
const userSessions = new Map();

// Bot Configuration
let ndii;
let isBotReady = false;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSIONS_DIR);
    
    const usePairingCode = true;
    
    ndii = makeWASocket({
        logger: pino({ level: "silent" }),
        printQRInTerminal: !usePairingCode,
        auth: state,
        browser: ["Ubuntu", "Chrome", "20.0.04"],
        generateHighQualityLinkPreview: true,
        syncFullHistory: true,
        markOnlineOnConnect: true,
        keepAliveIntervalMs: 30000,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000
    });

    // Pairing Code Logic
    if (usePairingCode && !ndii.authState.creds.registered) {
        console.log('\n🤖 NdiiClouD Bot Initialization\n');
        let phoneNumber = await question('📱 Masukan Nomor Aktif Admin (boleh +62, 62, atau 08):\n');
        
        // NORMALISASI NOMOR
        phoneNumber = phoneNumber
            .replace(/[^0-9+]/g, "") 
            .replace(/^0/, "62") 
            .replace(/^\+/, "")      
            .replace(/^620/, "62");
            
        if (!phoneNumber.startsWith("62")) {
            phoneNumber = "62" + phoneNumber;
        }
        
        const pair = "NAMIXAIZ"; // 8 huruf
        try {
            const code = await ndii.requestPairingCode(phoneNumber.trim(), pair);
            console.log(`\n✅ Pairing code: ${code}`);
            console.log(`📲 Masukkan kode di WhatsApp > Perangkat Tertaut > Tautkan Perangkat\n`);
        } catch (err) {
            console.error('❌ Error pairing:', err);
            process.exit(1);
        }
    }

    // Connection Handler
    ndii.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect } = update;
        
        if (connection === 'close') {
            const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Koneksi terputus:', lastDisconnect?.error?.message);
            if (shouldReconnect) {
                console.log('🔄 Mencoba reconnect...');
                await delay(5000);
                startBot();
            }
        } else if (connection === 'open') {
            console.log('✅ Bot NdiiClouD terhubung!');
            isBotReady = true;
            
            // Send startup notification to admin
            const adminNumber = fs.readJsonSync(SETTINGS_FILE).adminNumber;
            if (adminNumber) {
                await sendMessage(adminNumber, `🤖 *NdiiClouD Bot Aktif!*\n\n⏰ ${moment().tz('Asia/Jakarta').format('DD/MM/YYYY HH:mm:ss')}\n📊 Status: Online\n🌩️ Siap mengirim OTP dan notifikasi!`);
            }
            
            startScheduledTasks();
        }
    });

    // Credentials Update
    ndii.ev.on('creds.update', saveCreds);

    // Messages Handler
    ndii.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;
        
        const sender = ndii.decodeJid(msg.key.remoteJid);
        const text = msg.message.conversation || msg.message.extendedTextMessage?.text || '';
        
        // Admin commands
        await handleAdminCommands(sender, text, msg);
        
        // Auto reply
        await handleAutoReply(sender, text);
    });

    // Decode JID Helper
    ndii.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            let decode = jidDecode(jid) || {};
            return (decode.user && decode.server) ? `${decode.user}@${decode.server}` : jid;
        } else return jid;
    };
}

// Admin Commands Handler
async function handleAdminCommands(sender, text, msg) {
    const settings = fs.readJsonSync(SETTINGS_FILE);
    const adminNumber = settings.adminNumber;
    
    // Check if sender is admin
    const senderNumber = sender.split('@')[0];
    if (senderNumber !== adminNumber && sender !== adminNumber) return;
    
    const cmd = text.toLowerCase().trim();
    
    if (cmd === '/menu') {
        const menu = `🤖 *NdiiClouD Admin Menu*

📋 *Perintah Tersedia:*
• /broadcast [pesan] - Kirim ke semua user
• /stats - Statistik pengguna
• /otp [nomor] [kode] - Kirim OTP manual
• /reminder [pesan] - Kirim reminder
• /setadmin [nomor] - Ganti nomor admin
• /users - Daftar semua user
• /notify [nomor] [pesan] - Kirim notifikasi
• /ping - Cek status bot

🌩️ *NdiiClouD Bot v2.0*`;
        
        await sendMessage(sender, menu);
    }
    
    else if (cmd.startsWith('/broadcast ')) {
        const message = text.substring(11);
        await broadcastMessage(message);
        await sendMessage(sender, `✅ Broadcast terkirim ke semua user!`);
    }
    
    else if (cmd === '/stats') {
        const users = fs.readJsonSync(USERS_FILE);
        const userCount = Object.keys(users).length;
        const onlineUsers = Array.from(userSessions.values()).filter(u => u.online).length;
        
        const stats = `📊 *Statistik NdiiClouD*

👥 Total User: ${userCount}
🟢 Online: ${onlineUsers}
📅 ${moment().tz('Asia/Jakarta').format('DD MMMM YYYY')}
⏰ ${moment().tz('Asia/Jakarta').format('HH:mm:ss')}

🌩️ *NdiiClouD Systems*`;
        
        await sendMessage(sender, stats);
    }
    
    else if (cmd.startsWith('/otp ')) {
        const parts = text.split(' ');
        if (parts.length >= 3) {
            const phone = parts[1];
            const code = parts[2];
            await sendOTP(phone, code);
            await sendMessage(sender, `✅ OTP ${code} dikirim ke ${phone}`);
        }
    }
    
    else if (cmd.startsWith('/notify ')) {
        const parts = text.split(' ');
        if (parts.length >= 3) {
            const phone = parts[1];
            const message = parts.slice(2).join(' ');
            await sendMessage(phone, `🔔 *Notifikasi NdiiClouD*\n\n${message}\n\n🌩️ *NdiiClouD*`);
            await sendMessage(sender, `✅ Notifikasi terkirim!`);
        }
    }
}

// Auto Reply Handler
async function handleAutoReply(sender, text) {
    const lowerText = text.toLowerCase();
    
    if (lowerText.includes('halo') || lowerText.includes('hi')) {
        await sendMessage(sender, `👋 Halo! Saya *NdiiClouD Assistant*.\n\nSilakan login di website kami untuk mengakses fitur chat lengkap.\n\n🌩️ *NdiiClouD Chat*`);
    }
    else if (lowerText.includes('otp')) {
        await sendMessage(sender, `🔐 *OTP NdiiClouD*\n\nJika Anda meminta OTP, kode telah dikirim ke nomor Anda. Mohon periksa pesan masuk.\n\n⚠️ Jangan bagikan kode OTP kepada siapapun!`);
    }
    else if (lowerText.includes('bantuan') || lowerText.includes('help')) {
        await sendMessage(sender, `🆘 *Bantuan NdiiClouD*\n\n1. Login dengan nomor/email di website\n2. Masukkan kode OTP yang dikirim ke WhatsApp\n3. Nikmati fitur chat lengkap!\n\n📧 Email: support@ndiicloud.com\n🌐 Website: ndiicloud.com\n\n🌩️ *NdiiClouD Support*`);
    }
}

// Send Message Function
async function sendMessage(to, text) {
    if (!isBotReady) return false;
    
    try {
        const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
        await ndii.sendMessage(jid, { text: text });
        return true;
    } catch (err) {
        console.error('Error sending message:', err);
        return false;
    }
}

// Send OTP Function
async function sendOTP(phoneNumber, code) {
    const formattedNumber = phoneNumber.replace(/[^0-9]/g, '');
    const message = `🔐 *KODE OTP NdiiClouD*

Kode verifikasi Anda:
*${code}*

⏰ Berlaku selama 5 menit
🔒 Jangan bagikan kode ini kepada siapapun!

🌩️ *NdiiClouD Security*`;

    const success = await sendMessage(formattedNumber, message);
    
    if (success) {
        // Save OTP to file
        const otps = fs.readJsonSync(OTP_FILE);
        otps[formattedNumber] = {
            code: code,
            expires: Date.now() + (5 * 60 * 1000), // 5 minutes
            attempts: 0
        };
        fs.writeJsonSync(OTP_FILE, otps);
    }
    
    return success;
}

// Broadcast Message
async function broadcastMessage(message) {
    const users = fs.readJsonSync(USERS_FILE);
    const numbers = Object.keys(users);
    
    let success = 0;
    let failed = 0;
    
    for (const number of numbers) {
        const fullMessage = `📢 *PENGUMUMAN NdiiClouD*\n\n${message}\n\n🌩️ *Tim NdiiClouD*`;
        const result = await sendMessage(number, fullMessage);
        if (result) success++;
        else failed++;
        
        await delay(1000); // Delay to prevent rate limit
    }
    
    console.log(`Broadcast: ${success} sukses, ${failed} gagal`);
    return { success, failed };
}

// Scheduled Tasks
function startScheduledTasks() {
    // Daily reminder every 3 days at 10:00 AM
    cron.schedule('0 10 */3 * *', async () => {
        const users = fs.readJsonSync(USERS_FILE);
        const reminderMsg = `👋 *Halo!*\n\nKami rindu Anda! Jangan lupa mampir ke *NdiiClouD Chat* untuk terhubung dengan teman-teman.\n\n🌩️ *NdiiClouD*`;
        
        for (const [number, user] of Object.entries(users)) {
            if (!user.lastActive || (Date.now() - user.lastActive > 3 * 24 * 60 * 60 * 1000)) {
                await sendMessage(number, reminderMsg);
                await delay(2000);
            }
        }
    });
    
    // Clean expired OTPs every hour
    cron.schedule('0 * * * *', () => {
        const otps = fs.readJsonSync(OTP_FILE);
        const now = Date.now();
        let cleaned = 0;
        
        for (const [phone, data] of Object.entries(otps)) {
            if (data.expires < now) {
                delete otps[phone];
                cleaned++;
            }
        }
        
        fs.writeJsonSync(OTP_FILE, otps);
        console.log(`🧹 Cleaned ${cleaned} expired OTPs`);
    });
    
    console.log('⏰ Scheduled tasks started');
}

// API Functions for Web Integration
const botAPI = {
    sendOTP: async (phone) => {
        const code = Math.floor(100000 + Math.random() * 900000).toString();
        return await sendOTP(phone, code);
    },
    
    verifyOTP: (phone, code) => {
        const otps = fs.readJsonSync(OTP_FILE);
        const data = otps[phone.replace(/[^0-9]/g, '')];
        
        if (!data) return { valid: false, message: 'OTP tidak ditemukan' };
        if (data.expires < Date.now()) return { valid: false, message: 'OTP expired' };
        if (data.code !== code) {
            data.attempts++;
            fs.writeJsonSync(OTP_FILE, otps);
            return { valid: false, message: 'Kode salah' };
        }
        
        delete otps[phone];
        fs.writeJsonSync(OTP_FILE, otps);
        return { valid: true };
    },
    
    sendNotification: async (phone, message) => {
        return await sendMessage(phone, `🔔 *Notifikasi NdiiClouD*\n\n${message}\n\n🌩️ *NdiiClouD*`);
    },
    
    broadcast: broadcastMessage,
    
    getStats: () => {
        const users = fs.readJsonSync(USERS_FILE);
        return {
            totalUsers: Object.keys(users).length,
            onlineUsers: Array.from(userSessions.values()).filter(u => u.online).length,
            botStatus: isBotReady ? 'online' : 'offline'
        };
    },
    
    registerUser: (phone, data) => {
        const users = fs.readJsonSync(USERS_FILE);
        users[phone.replace(/[^0-9]/g, '')] = {
            ...data,
            registeredAt: Date.now(),
            lastActive: Date.now()
        };
        fs.writeJsonSync(USERS_FILE, users);
    },
    
    updateUserActivity: (phone) => {
        const users = fs.readJsonSync(USERS_FILE);
        const key = phone.replace(/[^0-9]/g, '');
        if (users[key]) {
            users[key].lastActive = Date.now();
            fs.writeJsonSync(USERS_FILE, users);
        }
    }
};

// Export for server.js
module.exports = { startBot, botAPI, isBotReady: () => isBotReady };

// Start if run directly
if (require.main === module) {
    startBot().catch(console.error);
}
