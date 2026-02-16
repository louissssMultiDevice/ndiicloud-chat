// /api/auth/otp.js
import { kv } from '@vercel/kv';

const ADMIN_SECRET = '#6287717274346';
const BOT_SERVICE_URL = process.env.WHATSAPP_BOT_URL || 'http://localhost:3001';

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { phone, email, type, adminCode } = req.body;
    
    // Admin login check
    if (adminCode === ADMIN_SECRET) {
      const sessionId = generateSessionId();
      await kv.set(`session:${sessionId}`, JSON.stringify({
        id: 'admin',
        name: 'Administrator',
        role: 'admin',
        phone: '6287717274346',
        createdAt: Date.now()
      }), { ex: 86400 }); // 24 hours
      
      return res.json({
        success: true,
        isAdmin: true,
        sessionId,
        user: {
          id: 'admin',
          name: 'Administrator',
          role: 'admin'
        }
      });
    }
    
    // Generate OTP
    const target = phone || email;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Store OTP in KV
    await kv.set(`otp:${target}`, JSON.stringify({
      code,
      expires: Date.now() + (5 * 60 * 1000), // 5 minutes
      attempts: 0
    }), { ex: 300 }); // 5 minutes TTL
    
    // Send OTP via external bot service
    if (type === 'phone' && phone) {
      try {
        const botResponse = await fetch(`${BOT_SERVICE_URL}/send-otp`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, code })
        });
        
        if (!botResponse.ok) {
          throw new Error('Bot service error');
        }
      } catch (err) {
        console.error('Bot service error:', err);
        // Fallback: log OTP for development
        console.log(`[DEV] OTP for ${phone}: ${code}`);
      }
    }
    
    return res.json({
      success: true,
      message: 'OTP sent successfully'
    });
    
  } catch (error) {
    console.error('OTP Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

function generateSessionId() {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}
